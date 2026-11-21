import { createStatusMap, type StoragePort } from '@tasuki/core'
import { describeStorageContract } from '@tasuki/testkit'
import { existsSync } from 'node:fs'
import { describe, it } from 'vite-plus/test'
import { createClient, createFetch, JiraHttpError } from './client'
import { parseOptions } from './options'
import { createJiraTracker } from './tracker'

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
  describeStorageContract('jira-cloud', () => {
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
    const ctx = {
      clock: { now: () => new Date() },
      configDir: '',
      dataDir: '',
      // Logical status -> Jira status id, as JSON.
      statuses: createStatusMap({
        item: JSON.parse(String(env['JIRA_TEST_ITEM_STATUSES'])) as Record<string, string>,
        task: JSON.parse(String(env['JIRA_TEST_TASK_STATUSES'])) as Record<string, string>,
      }),
    }
    const inner = createJiraTracker(ctx, options, jira, jiraFetch)
    const created: string[] = []
    const storage: StoragePort = {
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
    return Promise.resolve({ storage, teardown })
  })
} else {
  describe('StoragePort contract: jira-cloud', () => {
    it.skip('needs JIRA_* settings in the repo-root .env', () => {})
  })
}
