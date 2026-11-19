import { createStatusMap, type StoragePort } from '@tasuki/core'
import { describeStorageContract } from '@tasuki/testkit'
import { existsSync } from 'node:fs'
import { describe, it } from 'vite-plus/test'
import { createClient } from './client'
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
].every((k) => env[k])

if (configured) {
  describeStorageContract('jira-cloud', () => {
    const options = parseOptions({
      baseUrl: env['JIRA_BASE_URL'],
      email: env['JIRA_EMAIL'],
      apiToken: env['JIRA_API_TOKEN'],
      project: env['JIRA_TEST_PROJECT'],
      issueTypes: { item: env['JIRA_TEST_ITEM_TYPE'] },
    })
    const jira = createClient(options)
    const ctx = {
      clock: { now: () => new Date() },
      dataDir: '',
      // Logical status -> Jira status id, as JSON.
      statuses: createStatusMap({
        item: JSON.parse(String(env['JIRA_TEST_ITEM_STATUSES'])) as Record<string, string>,
      }),
    }
    const inner = createJiraTracker(ctx, options, jira)
    const created: string[] = []
    const storage: StoragePort = {
      list: (kind, status) => inner.list(kind, status),
      get: (ref) => inner.get(ref),
      transition: (ref, from, to) => inner.transition(ref, from, to),
      createItem: async (item) => {
        const unit = await inner.createItem(item)
        created.push(unit.ref)
        return unit
      },
    }
    const teardown = async (): Promise<void> => {
      for (const ref of created) await jira('DELETE', `/issue/${ref}`)
    }
    return Promise.resolve({ storage, teardown })
  })
} else {
  describe('StoragePort contract: jira-cloud', () => {
    it.skip('needs JIRA_* settings in the repo-root .env', () => {})
  })
}
