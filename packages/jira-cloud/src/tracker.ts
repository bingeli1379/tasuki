import {
  EditConflict,
  InvalidInput,
  MAX_ATTACHMENT_BYTES,
  NotFound,
  StatusConflict,
  type Attachment,
  type Comment,
  type CommentAuthor,
  type CommentKind,
  type Dependency,
  type Kind,
  type Origin,
  type PluginContext,
  type TrackerPort,
  type WorkUnit,
} from '@tasuki/core'
import { createHash } from 'node:crypto'
import { adfToMarkdown, markdownToAdf, mediaIds, type AdfDoc, type MediaMap } from './adf'
import { JiraHttpError, type JiraFetch, type JiraRequest } from './client'
import type { JiraOptions } from './options'

const FIELDS = [
  'summary',
  'description',
  'status',
  'labels',
  'issuetype',
  'project',
  'attachment',
  'parent',
  'subtasks',
  'issuelinks',
]

interface JiraAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  created: string
}

interface Issue {
  key: string
  fields: {
    summary: string
    description: AdfDoc | null
    status: { id: string }
    labels: string[]
    issuetype: { id: string }
    project: { key: string }
    attachment: JiraAttachment[]
    parent?: { key: string }
    // Read straight off the issue, so a sub-task shows here the moment it exists; a search
    // for it may lag (D54).
    subtasks?: { key: string }[]
    // As seen from this issue: inwardIssue is the other end of an "is blocked by".
    issuelinks?: { type: { id: string }; inwardIssue?: { key: string } }[]
  }
  renderedFields?: { description?: string | null }
  properties?: Record<string, unknown>
}

interface JiraComment {
  id: string
  author?: { displayName?: string }
  body: AdfDoc
  created: string
  renderedBody?: string
  properties?: { key: string; value: unknown }[]
}

// Jira's `updated` also moves when someone comments or attaches a file, which would make an
// edit started before an upload look stale. The version is the content an edit overwrites.
function versionOf(issue: Issue): string {
  return createHash('sha256')
    .update(
      JSON.stringify([issue.fields.summary, issue.fields.description, issue.fields.status.id]),
    )
    .digest('base64url')
    .slice(0, 16)
}

// Agent and engine comments carry this property; a comment without it was written by a
// person, in tasuki or straight in Jira (D61).
const PROPERTY = 'tasuki'

const authorNameOf = (tasuki?: string, jira?: string): { authorName?: string } =>
  tasuki ? { authorName: tasuki } : jira ? { authorName: jira } : {}

// Jira shows every comment as the token's owner, so agent and engine comments also start
// with a visible line saying who wrote them. Reading strips it back off.
const prefixOf = (author: CommentAuthor, kind: CommentKind): string =>
  `tasuki · ${author}${kind === 'note' ? '' : ` · ${kind}`}`

// The rendered HTML is the only place Jira pairs an image's media id with its attachment id.
function mediaMapFrom(html: string | null | undefined, attachments: JiraAttachment[]): MediaMap {
  const byId = new Map(attachments.map((a) => [a.id, a]))
  const map = new Map<string, { id: string; filename: string }>()
  for (const m of (html ?? '').matchAll(
    /href="\/rest\/api\/3\/attachment\/content\/(\d+)"[^]*?data-media-services-id="([^"]+)"/g,
  )) {
    const attachment = byId.get(m[1]!)
    if (attachment) map.set(m[2]!, { id: attachment.id, filename: attachment.filename })
  }
  return map
}

const toAttachment = (target: string, a: JiraAttachment): Attachment => ({
  id: String(a.id),
  target,
  filename: a.filename,
  mimeType: a.mimeType,
  size: a.size,
  createdAt: a.created,
})

export function createJiraTracker(
  ctx: PluginContext,
  options: JiraOptions,
  jira: JiraRequest,
  jiraFetch: JiraFetch,
): TrackerPort {
  const getIssue = (key: string, rendered = false): Promise<Issue> =>
    jira(
      'GET',
      `/issue/${key}?fields=${FIELDS.join(',')}&properties=${PROPERTY}${rendered ? '&expand=renderedFields' : ''}`,
    )

  const kindOf = (issue: Issue): Kind | undefined =>
    issue.fields.issuetype.id === options.issueTypes.item
      ? 'item'
      : issue.fields.issuetype.id === options.issueTypes.task
        ? 'task'
        : undefined

  // An issue outside the project or of a type tasuki does not use is not ours.
  async function getUnit(key: string): Promise<Issue> {
    let issue: Issue
    try {
      issue = await getIssue(key)
    } catch (e) {
      if (e instanceof JiraHttpError && e.status === 404)
        throw new NotFound(`${key} does not exist`)
      throw e
    }
    if (issue.fields.project.key !== options.project || kindOf(issue) === undefined)
      throw new NotFound(`${key} is not a tasuki item or task in ${options.project}`)
    return issue
  }

  async function getItem(key: string): Promise<Issue> {
    const issue = await getUnit(key)
    if (kindOf(issue) !== 'item') throw new NotFound(`${key} is not an item`)
    return issue
  }

  async function search(jql: string): Promise<Issue[]> {
    const issues: Issue[] = []
    let nextPageToken: string | undefined
    do {
      const page = await jira<{ issues: Issue[]; nextPageToken?: string }>('POST', '/search/jql', {
        jql,
        fields: FIELDS,
        properties: [PROPERTY],
        maxResults: 100,
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      })
      issues.push(...page.issues)
      nextPageToken = page.nextPageToken
    } while (nextPageToken !== undefined)
    return issues
  }

  // Bulk fetch reads the issues themselves; a search, even `key in (...)`, can miss one made
  // a moment ago (D54). Ordered as the parent lists them, which is creation order.
  async function childIssues(item: string): Promise<Issue[]> {
    const keys = ((await getItem(item)).fields.subtasks ?? []).map((t) => t.key)
    const issues: Issue[] = []
    for (let i = 0; i < keys.length; i += 100) {
      const page = await jira<{ issues: Issue[] }>('POST', '/issue/bulkfetch', {
        issueIdsOrKeys: keys.slice(i, i + 100),
        fields: FIELDS,
        properties: [PROPERTY],
      })
      issues.push(...page.issues)
    }
    return issues
      .filter((issue) => kindOf(issue) === 'task')
      .sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key))
  }

  async function toWorkUnit(issue: Issue): Promise<WorkUnit> {
    const description = issue.fields.description
    // Rendering costs Jira a pass over the issue, so it is asked for only when there are images.
    let mediaMap: MediaMap = new Map()
    if (mediaIds(description).length > 0) {
      const html =
        issue.renderedFields?.description ??
        (await getIssue(issue.key, true)).renderedFields?.description
      mediaMap = mediaMapFrom(html, issue.fields.attachment)
    }
    const key = issue.fields.status.id
    const kind = kindOf(issue) ?? 'item'
    // A sub-task made in Jira by hand carries no property: a person's.
    const origin = (issue.properties?.[PROPERTY] as { origin?: Origin } | undefined)?.origin
    return {
      ref: issue.key,
      kind,
      // An item's parent is its epic, which tasuki does not track.
      ...(kind === 'task' && issue.fields.parent ? { parent: issue.fields.parent.key } : {}),
      title: issue.fields.summary,
      body: adfToMarkdown(description, mediaMap),
      status: ctx.statuses.fromTracker(kind, key) ?? key,
      labels: issue.fields.labels,
      ...(kind === 'task' ? { origin: origin ?? 'human' } : {}),
      version: versionOf(issue),
    }
  }

  // Jira embeds an image by its media id, which only shows in the URL an attachment's
  // download redirects to. Not a documented API: if it stops appearing, saving an image
  // fails with this error and nothing is written (D61).
  function mediaResolver(issue: Issue): (attachmentId: string) => Promise<string> {
    return async (attachmentId) => {
      if (!issue.fields.attachment.some((a) => String(a.id) === attachmentId))
        throw new InvalidInput(`${issue.key} has no attachment ${attachmentId}`)
      const res = await jiraFetch(`/attachment/content/${attachmentId}`, {
        redirect: 'manual',
        headers: { Accept: '*/*' },
      })
      const id = /\/file\/([0-9a-f-]{36})\//.exec(res.headers.get('location') ?? '')?.[1]
      if (id === undefined)
        throw new Error(`Jira did not reveal the media id of attachment ${attachmentId}`)
      return id
    }
  }

  async function moveTo(key: string, statusId: string): Promise<void> {
    const { transitions } = await jira<{ transitions: { id: string; to: { id: string } }[] }>(
      'GET',
      `/issue/${key}/transitions`,
    )
    const transition = transitions.find((t) => t.to.id === statusId)
    if (transition === undefined)
      throw new Error(`${key}: the workflow has no transition to status ${statusId}`)
    await jira('POST', `/issue/${key}/transitions`, { transition: { id: transition.id } })
  }

  async function toComment(target: string, c: JiraComment, mediaMap: MediaMap): Promise<Comment> {
    const meta = c.properties?.find((p) => p.key === PROPERTY)?.value as
      | { author: CommentAuthor; kind: CommentKind; name?: string }
      | undefined
    const author = meta?.author ?? 'human'
    const kind = meta?.kind ?? 'note'
    let content = c.body.content
    const first = content[0]?.content?.map((n) => n.text ?? '').join('')
    if (meta && first === prefixOf(author, kind)) content = content.slice(1)
    return {
      id: c.id,
      target,
      author,
      ...authorNameOf(meta?.name, c.author?.displayName),
      kind,
      body: adfToMarkdown({ ...c.body, content }, mediaMap),
      createdAt: c.created,
    }
  }

  return {
    async list(kind, statuses) {
      // `status in ()` is not valid JQL.
      if (statuses.length === 0) return []
      const keys = statuses.map((s) => ctx.statuses.toTracker(kind, s))
      const issues = await search(
        `project = "${options.project}" AND issuetype = ${options.issueTypes[kind]} AND status in (${keys.join(', ')}) ORDER BY created ASC`,
      )
      return Promise.all(issues.map(toWorkUnit))
    },

    async children(item) {
      return Promise.all((await childIssues(item)).map(toWorkUnit))
    },

    async dependencies(item) {
      const issues = await childIssues(item)
      const siblings = new Set(issues.map((i) => i.key))
      return issues.flatMap((issue): Dependency[] =>
        (issue.fields.issuelinks ?? [])
          .filter((l) => l.type.id === options.dependencyLinkType)
          .flatMap((l) =>
            l.inwardIssue && siblings.has(l.inwardIssue.key)
              ? [{ task: issue.key, blockedBy: l.inwardIssue.key }]
              : [],
          ),
      )
    },

    // Three kinds of call, none atomic together (D47): if a link fails the task exists
    // without it, and the error says so.
    async createTask(item, task) {
      const parent = await getItem(item)
      const siblings = new Set((parent.fields.subtasks ?? []).map((t) => t.key))
      const foreign = task.blockedBy.filter((ref) => !siblings.has(ref))
      if (foreign.length > 0)
        throw new InvalidInput(`${foreign.join(', ')} is not a task of ${item}`)
      const statusId = ctx.statuses.toTracker('task', task.status)
      const fields: Record<string, unknown> = {
        project: { key: options.project },
        issuetype: { id: options.issueTypes.task },
        parent: { key: item },
        summary: task.title,
      }
      if (task.body !== '')
        fields['description'] = await markdownToAdf(task.body, (id) =>
          Promise.reject(new InvalidInput(`a new task has no attachment ${id} yet`)),
        )
      const { key } = await jira<{ key: string }>('POST', '/issue', {
        fields,
        properties: [{ key: PROPERTY, value: { origin: task.origin } }],
      })
      if ((await getIssue(key)).fields.status.id !== statusId) await moveTo(key, statusId)
      for (const blocker of task.blockedBy)
        await jira('POST', '/issueLink', {
          type: { id: options.dependencyLinkType },
          inwardIssue: { key: blocker },
          outwardIssue: { key },
        })
      return toWorkUnit(await getIssue(key))
    },

    async createItem(item) {
      const statusId = ctx.statuses.toTracker('item', item.status)
      const fields: Record<string, unknown> = {
        project: { key: options.project },
        issuetype: { id: options.issueTypes.item },
        summary: item.title,
      }
      // A new issue has no attachments yet, so its body cannot embed one.
      if (item.body !== '')
        fields['description'] = await markdownToAdf(item.body, (id) =>
          Promise.reject(new InvalidInput(`a new item has no attachment ${id} yet`)),
        )
      const { key } = await jira<{ key: string }>('POST', '/issue', { fields })
      // New issues land in the workflow's initial status. Two calls, not atomic (D47):
      // if the move fails the issue stays where Jira put it, and the error says so.
      let issue = await getIssue(key)
      if (issue.fields.status.id !== statusId) {
        await moveTo(key, statusId)
        issue = await getIssue(key)
      }
      return toWorkUnit(issue)
    },

    async get(ref) {
      return toWorkUnit(await getUnit(ref))
    },

    // Jira has no conditional transition, so this re-reads right before moving and accepts
    // the small window between the two calls (stop-and-recovery.md).
    async transition(ref, expectedFrom, to) {
      const issue = await getUnit(ref)
      const kind = kindOf(issue) ?? 'item'
      if (issue.fields.status.id !== ctx.statuses.toTracker(kind, expectedFrom))
        throw new StatusConflict(expectedFrom, await toWorkUnit(issue))
      await moveTo(ref, ctx.statuses.toTracker(kind, to))
      return toWorkUnit(await getIssue(ref))
    },

    // Same re-read before writing as transition.
    async updateItem(ref, expectedVersion, patch) {
      const issue = await getUnit(ref)
      if (versionOf(issue) !== expectedVersion) throw new EditConflict(await toWorkUnit(issue))
      const fields: Record<string, unknown> = {}
      if (patch.title !== undefined) fields['summary'] = patch.title
      if (patch.body !== undefined)
        fields['description'] =
          patch.body === '' ? null : await markdownToAdf(patch.body, mediaResolver(issue))
      await jira('PUT', `/issue/${ref}`, { fields })
      return toWorkUnit(await getIssue(ref))
    },

    // Jira takes the issue's links, comments and attachments with it.
    async deleteTask(ref) {
      if (kindOf(await getUnit(ref)) !== 'task') throw new NotFound(`${ref} is not a task`)
      await jira('DELETE', `/issue/${ref}`)
    },

    // Its sub-tasks go with it, and Jira takes their links, comments and attachments along.
    async deleteItem(ref) {
      if (kindOf(await getUnit(ref)) !== 'item') throw new NotFound(`${ref} is not an item`)
      await jira('DELETE', `/issue/${ref}?deleteSubtasks=true`)
    },

    // update.labels adds or removes the one label, unlike fields.labels, which replaces all.
    async addLabel(ref, label) {
      await getUnit(ref)
      await jira('PUT', `/issue/${ref}`, { update: { labels: [{ add: label }] } })
      return toWorkUnit(await getIssue(ref))
    },
    async removeLabel(ref, label) {
      await getUnit(ref)
      await jira('PUT', `/issue/${ref}`, { update: { labels: [{ remove: label }] } })
      return toWorkUnit(await getIssue(ref))
    },

    async comments(target) {
      await getUnit(target)
      const fetchAll = async (expand: string): Promise<JiraComment[]> => {
        const all: JiraComment[] = []
        let total = 0
        do {
          const page = await jira<{ comments: JiraComment[]; total: number }>(
            'GET',
            `/issue/${target}/comment?orderBy=created&expand=${expand}&startAt=${all.length}&maxResults=100`,
          )
          all.push(...page.comments)
          total = page.total
          if (page.comments.length === 0) break
        } while (all.length < total)
        return all
      }
      let comments = await fetchAll('properties')
      let mediaMap: MediaMap = new Map()
      if (comments.some((c) => mediaIds(c.body).length > 0)) {
        comments = await fetchAll('properties,renderedBody')
        const issue = await getIssue(target)
        mediaMap = mediaMapFrom(
          comments.map((c) => c.renderedBody ?? '').join('\n'),
          issue.fields.attachment,
        )
      }
      return Promise.all(comments.map((c) => toComment(target, c, mediaMap)))
    },

    async addComment(comment) {
      const issue = await getUnit(comment.target)
      const body = await markdownToAdf(comment.body, mediaResolver(issue))
      const human = comment.author === 'human'
      // A person's own note written before sign-in existed is the only comment without the
      // property: one written straight in Jira has none either. A person's system line (D74)
      // carries it, with no visible prefix. Every comment tasuki writes shows the engine's
      // Jira account, so the signed-in person's name rides in the property (D89).
      const tagged = !human || comment.kind !== 'note' || comment.authorName !== undefined
      if (!human)
        body.content.unshift({
          type: 'paragraph',
          content: [
            { type: 'text', text: prefixOf(comment.author, comment.kind), marks: [{ type: 'em' }] },
          ],
        })
      const created = await jira<JiraComment>('POST', `/issue/${comment.target}/comment`, {
        body,
        ...(!tagged
          ? {}
          : {
              properties: [
                {
                  key: PROPERTY,
                  value: {
                    author: comment.author,
                    kind: comment.kind,
                    ...(comment.authorName === undefined ? {} : { name: comment.authorName }),
                  },
                },
              ],
            }),
      })
      return {
        id: created.id,
        target: comment.target,
        author: comment.author,
        ...authorNameOf(comment.authorName, created.author?.displayName),
        kind: comment.kind,
        body: comment.body,
        createdAt: created.created,
      }
    },

    async attachments(target) {
      const issue = await getUnit(target)
      return issue.fields.attachment.map((a) => toAttachment(target, a))
    },

    async addAttachment(target, attachment) {
      await getUnit(target)
      const form = new FormData()
      form.append(
        'file',
        new Blob([attachment.data as Uint8Array<ArrayBuffer>], { type: attachment.mimeType }),
        attachment.filename,
      )
      const res = await jiraFetch(`/issue/${target}/attachments`, {
        method: 'POST',
        // Jira refuses uploads without this, as CSRF protection.
        headers: { 'X-Atlassian-Token': 'no-check' },
        body: form,
      })
      const [created] = (await res.json()) as JiraAttachment[]
      if (created === undefined) throw new Error(`Jira returned no attachment for ${target}`)
      return toAttachment(target, created)
    },

    async readAttachment(target, id) {
      const issue = await getUnit(target)
      const found = issue.fields.attachment.find((a) => String(a.id) === id)
      if (found === undefined) throw new NotFound(`${target} has no attachment ${id}`)
      // Someone may have put a far bigger file on the issue in Jira; the engine would hold
      // all of it in memory to pass it on.
      if (found.size > MAX_ATTACHMENT_BYTES)
        throw new InvalidInput(`${found.filename} is larger than 10 MB; open it in Jira`)
      // The download redirects to Atlassian's media service with a token in the URL.
      const res = await jiraFetch(`/attachment/content/${id}`, { headers: { Accept: '*/*' } })
      return {
        attachment: toAttachment(target, found),
        data: new Uint8Array(await res.arrayBuffer()),
      }
    },

    async deleteAttachment(target, id) {
      const issue = await getUnit(target)
      // The attachment API takes any id, so check it belongs to this issue first.
      if (!issue.fields.attachment.some((a) => String(a.id) === id))
        throw new NotFound(`${target} has no attachment ${id}`)
      await jira('DELETE', `/attachment/${id}`)
    },
  }
}
