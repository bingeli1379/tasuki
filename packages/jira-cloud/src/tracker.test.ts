import { createStatusMap, type TrackerPort } from '@tasuki/core'
import { describeTrackerContract } from '@tasuki/testkit'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vite-plus/test'
import { createClient, createFetch, JiraHttpError } from './client'
import { parseOptions } from './options'
import { allowsMove, createJiraTracker } from './tracker'

describe('jira-cloud allowsMove', () => {
  const workflow = {
    name: 'w',
    statuses: [],
    transitions: [
      { type: 'INITIAL' as const, toStatusReference: '1' },
      { type: 'GLOBAL' as const, toStatusReference: '2' },
      { type: 'DIRECTED' as const, toStatusReference: '3', links: [{ fromStatusReference: '2' }] },
    ],
  }

  it('a global transition is open from anywhere, a directed one from its links only', () => {
    expect(allowsMove(workflow, '3', '2')).toBe(true)
    expect(allowsMove(workflow, '2', '3')).toBe(true)
    expect(allowsMove(workflow, '1', '3')).toBe(false)
    expect(allowsMove(workflow, '2', '1')).toBe(false)
  })
})

// Runs against a real Jira test project when the repo-root .env has the JIRA_* settings; skipped in CI.
const envFile = new URL('../../../.env', import.meta.url)
if (existsSync(envFile)) process.loadEnvFile(envFile)
const env = process.env
const configured = [
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_TEST_PROJECT',
  'JIRA_TEST_ITEM_TYPE',
  'JIRA_TEST_ITEM_STATUSES',
  'JIRA_TEST_TASK_TYPE',
  'JIRA_TEST_TASK_STATUSES',
  'JIRA_TEST_LINK_TYPE',
].every((k) => env[k])

if (configured) {
  const options = parseOptions({
    baseUrl: env['JIRA_BASE_URL'],
    email: env['JIRA_EMAIL'],
    apiToken: env['JIRA_API_TOKEN'],
    project: env['JIRA_TEST_PROJECT'],
    issueTypes: { item: env['JIRA_TEST_ITEM_TYPE'], task: env['JIRA_TEST_TASK_TYPE'] },
    dependencyLinkType: env['JIRA_TEST_LINK_TYPE'],
  })
  const jiraFetch = createFetch(options)
  const jira = createClient(jiraFetch)
  // Logical status -> Jira status id, as JSON.
  const mapping = {
    item: JSON.parse(String(env['JIRA_TEST_ITEM_STATUSES'])) as Record<string, string>,
    task: JSON.parse(String(env['JIRA_TEST_TASK_STATUSES'])) as Record<string, string>,
  }
  const ctx = {
    clock: { now: () => new Date() },
    configDir: '',
    dataDir: '',
    statuses: createStatusMap(mapping),
  }

  describe('jira-cloud listStatuses', () => {
    it('lists, per kind, the statuses its issue type can be in, by id', async () => {
      const tracker = createJiraTracker(ctx, options, jira, jiraFetch)
      for (const kind of ['item', 'task'] as const) {
        const listed = await tracker.listStatuses?.(kind)
        expect(listed?.map((s) => s.key)).toEqual(
          expect.arrayContaining(Object.values(mapping[kind])),
        )
        expect(listed?.every((s) => s.name !== '')).toBe(true)
      }
    })
  })

  describe('jira-cloud doctor', () => {
    it('finds every move allowed and every status on the board, in the test project', async () => {
      const tracker = createJiraTracker(ctx, options, jira, jiraFetch)
      expect(
        await tracker.doctor?.([
          { kind: 'item', from: 'ready-to-split', to: 'split-review' },
          { kind: 'task', from: 'to-do', to: 'in-progress' },
        ]),
      ).toEqual([])
    })
  })

  describeTrackerContract('jira-cloud', () => {
    const inner = createJiraTracker(ctx, options, jira, jiraFetch)
    const created: string[] = []
    const tracker: TrackerPort = {
      ...inner,
      createItem: async (item) => {
        const unit = await inner.createItem(item)
        created.push(unit.ref)
        return unit
      },
    }
    const teardown = async (): Promise<void> => {
      // A test may have deleted its item already.
      await Promise.all(
        created.map((ref) =>
          jira('DELETE', `/issue/${ref}?deleteSubtasks=true`).catch((e: unknown) => {
            if (!(e instanceof JiraHttpError && e.status === 404)) throw e
          }),
        ),
      )
    }
    return Promise.resolve({ tracker, teardown })
  })
} else {
  describe('TrackerPort contract: jira-cloud', () => {
    it.skip('needs JIRA_* settings in the repo-root .env', () => {})
  })
}
