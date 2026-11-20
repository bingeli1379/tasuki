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
  type PluginContext,
  type StoragePort,
  type WorkUnit,
} from '@tasuki/core'
import { createHash } from 'node:crypto'
import { adfToMarkdown, markdownToAdf, mediaIds, type AdfDoc, type MediaMap } from './adf'
import { JiraHttpError, type JiraFetch, type JiraRequest } from './client'
import type { JiraOptions } from './options'

const FIELDS = ['summary', 'description', 'status', 'labels', 'issuetype', 'project', 'attachment']

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
  }
  renderedFields?: { description?: string | null }
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
): StoragePort {
  const getIssue = (key: string, rendered = false): Promise<Issue> =>
    jira(
      'GET',
      `/issue/${key}?fields=${FIELDS.join(',')}${rendered ? '&expand=renderedFields' : ''}`,
    )

  // Only items exist so far; an issue outside the project or of another type is not ours.
  async function getItem(key: string): Promise<Issue> {
    let issue: Issue
    try {
      issue = await getIssue(key)
    } catch (e) {
      if (e instanceof JiraHttpError && e.status === 404)
        throw new NotFound(`${key} does not exist`)
      throw e
    }
    if (
      issue.fields.project.key !== options.project ||
      issue.fields.issuetype.id !== options.issueTypes.item
    )
      throw new NotFound(`${key} is not a tasuki item in ${options.project}`)
    return issue
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
    return {
      ref: issue.key,
      kind: 'item',
      title: issue.fields.summary,
      body: adfToMarkdown(description, mediaMap),
      status: ctx.statuses.fromTracker('item', key) ?? key,
      labels: issue.fields.labels,
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
      | { author: CommentAuthor; kind: CommentKind }
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
      ...(c.author?.displayName ? { authorName: c.author.displayName } : {}),
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
      const jql = `project = "${options.project}" AND issuetype = ${options.issueTypes.item} AND status in (${keys.join(', ')}) ORDER BY created ASC`
      const issues: Issue[] = []
      let nextPageToken: string | undefined
      do {
        const page = await jira<{ issues: Issue[]; nextPageToken?: string }>(
          'POST',
          '/search/jql',
          {
            jql,
            fields: FIELDS,
            maxResults: 100,
            ...(nextPageToken === undefined ? {} : { nextPageToken }),
          },
        )
        issues.push(...page.issues)
        nextPageToken = page.nextPageToken
      } while (nextPageToken !== undefined)
      return Promise.all(issues.map(toWorkUnit))
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
      return toWorkUnit(await getItem(ref))
    },

    // Jira has no conditional transition, so this re-reads right before moving and accepts
    // the small window between the two calls (stop-and-recovery.md).
    async transition(ref, expectedFrom, to) {
      const issue = await getItem(ref)
      if (issue.fields.status.id !== ctx.statuses.toTracker('item', expectedFrom))
        throw new StatusConflict(expectedFrom, await toWorkUnit(issue))
      await moveTo(ref, ctx.statuses.toTracker('item', to))
      return toWorkUnit(await getIssue(ref))
    },

    // Same re-read before writing as transition.
    async updateItem(ref, expectedVersion, patch) {
      const issue = await getItem(ref)
      if (versionOf(issue) !== expectedVersion) throw new EditConflict(await toWorkUnit(issue))
      const fields: Record<string, unknown> = {}
      if (patch.title !== undefined) fields['summary'] = patch.title
      if (patch.body !== undefined)
        fields['description'] =
          patch.body === '' ? null : await markdownToAdf(patch.body, mediaResolver(issue))
      await jira('PUT', `/issue/${ref}`, { fields })
      return toWorkUnit(await getIssue(ref))
    },

    async comments(target) {
      await getItem(target)
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
      const issue = await getItem(comment.target)
      const body = await markdownToAdf(comment.body, mediaResolver(issue))
      const human = comment.author === 'human'
      if (!human)
        body.content.unshift({
          type: 'paragraph',
          content: [
            { type: 'text', text: prefixOf(comment.author, comment.kind), marks: [{ type: 'em' }] },
          ],
        })
      const created = await jira<JiraComment>('POST', `/issue/${comment.target}/comment`, {
        body,
        ...(human
          ? {}
          : {
              properties: [
                { key: PROPERTY, value: { author: comment.author, kind: comment.kind } },
              ],
            }),
      })
      return {
        id: created.id,
        target: comment.target,
        author: comment.author,
        ...(created.author?.displayName ? { authorName: created.author.displayName } : {}),
        kind: comment.kind,
        body: comment.body,
        createdAt: created.created,
      }
    },

    async attachments(target) {
      const issue = await getItem(target)
      return issue.fields.attachment.map((a) => toAttachment(target, a))
    },

    async addAttachment(target, attachment) {
      await getItem(target)
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
      const issue = await getItem(target)
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
  }
}
