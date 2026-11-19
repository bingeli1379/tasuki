import {
  NotFound,
  StatusConflict,
  type Kind,
  type PluginContext,
  type StoragePort,
  type WorkUnit,
} from '@tasuki/core'
import { adfToText, textToAdf, type AdfDoc } from './adf'
import { JiraHttpError, type JiraRequest } from './client'
import type { JiraOptions } from './options'

const FIELDS = ['summary', 'description', 'status', 'labels', 'issuetype', 'project']

interface Issue {
  key: string
  fields: {
    summary: string
    description: AdfDoc | null
    status: { id: string }
    labels: string[]
    issuetype: { id: string }
    project: { key: string }
  }
}

function toWorkUnit(ctx: PluginContext, kind: Kind, issue: Issue): WorkUnit {
  const key = issue.fields.status.id
  return {
    ref: issue.key,
    kind,
    title: issue.fields.summary,
    body: adfToText(issue.fields.description),
    status: ctx.statuses.fromTracker(kind, key) ?? key,
    labels: issue.fields.labels,
  }
}

export function createJiraTracker(
  ctx: PluginContext,
  options: JiraOptions,
  jira: JiraRequest,
): StoragePort {
  const getIssue = (key: string): Promise<Issue> =>
    jira('GET', `/issue/${key}?fields=${FIELDS.join(',')}`)

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

  return {
    async list(kind, status) {
      const jql = `project = "${options.project}" AND issuetype = ${options.issueTypes.item} AND status = ${ctx.statuses.toTracker(kind, status)} ORDER BY created ASC`
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
      return issues.map((i) => toWorkUnit(ctx, kind, i))
    },

    async createItem(item) {
      const statusId = ctx.statuses.toTracker('item', item.status)
      const fields: Record<string, unknown> = {
        project: { key: options.project },
        issuetype: { id: options.issueTypes.item },
        summary: item.title,
      }
      if (item.body !== '') fields['description'] = textToAdf(item.body)
      const { key } = await jira<{ key: string }>('POST', '/issue', { fields })
      // New issues land in the workflow's initial status. Two calls, not atomic (D47):
      // if the move fails the issue stays where Jira put it, and the error says so.
      let issue = await getIssue(key)
      if (issue.fields.status.id !== statusId) {
        await moveTo(key, statusId)
        issue = await getIssue(key)
      }
      return toWorkUnit(ctx, 'item', issue)
    },
    async get(ref) {
      return toWorkUnit(ctx, 'item', await getItem(ref))
    },

    // Jira has no conditional transition, so this re-reads right before moving and accepts
    // the small window between the two calls (stop-and-recovery.md).
    async transition(ref, expectedFrom, to) {
      const issue = await getItem(ref)
      if (issue.fields.status.id !== ctx.statuses.toTracker('item', expectedFrom))
        throw new StatusConflict(expectedFrom, toWorkUnit(ctx, 'item', issue))
      await moveTo(ref, ctx.statuses.toTracker('item', to))
      return toWorkUnit(ctx, 'item', await getIssue(ref))
    },
  }
}
