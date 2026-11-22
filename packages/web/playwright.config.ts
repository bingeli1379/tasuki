import { defineConfig, type PlaywrightTestConfig } from '@playwright/test'
import { DEFAULT_WORKFLOW } from '@tasuki/core'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const envFile = join(repoRoot, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const jiraVars = [
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_TEST_PROJECT',
  'JIRA_TEST_ITEM_TYPE',
  'JIRA_TEST_ITEM_STATUSES',
  'JIRA_TEST_TASK_TYPE',
  'JIRA_TEST_TASK_STATUSES',
  'JIRA_TEST_LINK_TYPE',
]
const withJira = jiraVars.every((v) => process.env[v])

// Workers load this file again; reuse the folder the main process made.
process.env['TASUKI_E2E_DIR'] ??= mkdtempSync(join(tmpdir(), 'tasuki-e2e-'))
const dir = process.env['TASUKI_E2E_DIR']

// --project names given on the command line; none means every project runs.
const picked = process.argv.flatMap((arg, i, all) =>
  arg === '--project' ? [all[i + 1]] : arg.startsWith('--project=') ? [arg.slice(10)] : [],
)

// The Jira project is shared with whatever was tried on it by hand, and the engine under test
// picks up any item in a watched status: a leftover [fake:hang] holds a Run slot for good. So
// every Jira run starts from an empty project. Before the web servers start, so no engine has
// claimed a leftover yet; once, since workers load this file again.
async function emptyJiraProject(): Promise<void> {
  const { JIRA_BASE_URL: base, JIRA_EMAIL, JIRA_API_TOKEN } = process.env
  const headers = {
    Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  const jql = `project = ${process.env['JIRA_TEST_PROJECT']} AND issuetype = ${process.env['JIRA_TEST_ITEM_TYPE']}`
  const keys: string[] = []
  let nextPageToken: string | undefined
  do {
    const res = await fetch(`${base}/rest/api/3/search/jql`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jql, fields: ['key'], maxResults: 100, nextPageToken }),
    })
    if (!res.ok) throw new Error(`emptying the Jira test project: search ${res.status}`)
    const page = (await res.json()) as { issues: { key: string }[]; nextPageToken?: string }
    keys.push(...page.issues.map((i) => i.key))
    nextPageToken = page.nextPageToken
  } while (nextPageToken !== undefined)
  for (const key of keys) {
    const res = await fetch(`${base}/rest/api/3/issue/${key}?deleteSubtasks=true`, {
      method: 'DELETE',
      headers,
    })
    if (!res.ok && res.status !== 404)
      throw new Error(`emptying the Jira test project: delete ${key} ${res.status}`)
  }
}
if (
  withJira &&
  (picked.length === 0 || picked.includes('jira')) &&
  process.env['TASUKI_E2E_JIRA_EMPTIED'] === undefined
) {
  process.env['TASUKI_E2E_JIRA_EMPTIED'] = '1'
  await emptyJiraProject()
}

// Rules split, execute and rework on the fake runner (S4, S6, S7b), and an AI review station
// whose rule sends the item one of two ways (W2). Polling every 2 seconds keeps the Jira
// run short; the agent takes 10, longer than the board needs to read itself again and show
// it Running.
const engineRules = {
  poll: { intervalSeconds: 2 },
  agents: { fake: { plugin: '@tasuki/fake-runner', options: { seconds: 10 } } },
  rules: [
    {
      id: 'split',
      watch: 'ready-to-split',
      claim: 'splitting',
      agent: 'fake',
      mode: 'split',
      outcomes: { succeeded: 'split-review', needs_input: 'needs-answers' },
    },
    {
      id: 'execute',
      watch: 'in-progress',
      agent: 'fake',
      mode: 'execute',
      outcomes: { succeeded: 'in-review', needs_input: 'blocked', blocked_manual: 'blocked' },
    },
    {
      id: 'rework',
      watch: 'ready-to-rework',
      claim: 'splitting',
      agent: 'fake',
      mode: 'rework',
      outcomes: { succeeded: 'split-review', needs_input: 'blocked' },
    },
    {
      id: 'ai-review',
      watch: 'ai-review',
      agent: 'fake',
      mode: 'review',
      outcomes: { approve: 'in-review', changes: 'ready-to-rework' },
    },
  ],
}

function engine(name: string, port: number, config: object): string {
  const file = join(dir, `${name}.config.jsonc`)
  writeFileSync(
    file,
    JSON.stringify({ dataDir: `./${name}`, server: { port }, ...engineRules, ...config }),
  )
  return file
}

// Statuses of its own on top of the default ten, after Done so no drag in the other tests
// has further to go.
const stations = [
  ...DEFAULT_WORKFLOW.statuses,
  { id: 'triage', handledBy: 'person', outcomes: ['ready-to-split'] },
  { id: 'ai-review', name: 'AI Review' },
]

// Keyed by the KAN status ids the env maps each logical name to.
function jiraWorkflow(): object {
  const keys: Record<string, string> = JSON.parse(String(process.env['JIRA_TEST_ITEM_STATUSES']))
  return {
    statuses: stations
      .filter((s) => keys[s.id] !== undefined)
      .map((s) => ({ ...s, key: keys[s.id] })),
    roles: DEFAULT_WORKFLOW.roles,
    taskStatuses: JSON.parse(String(process.env['JIRA_TEST_TASK_STATUSES'])),
  }
}

const trackers = [
  {
    name: 'sqlite',
    api: 8788,
    web: 5180,
    config: { workflow: { statuses: stations, roles: DEFAULT_WORKFLOW.roles } },
  },
  ...(withJira
    ? [
        {
          name: 'jira',
          api: 8789,
          web: 5181,
          config: {
            tracker: {
              plugin: '@tasuki/jira-cloud',
              options: {
                baseUrl: process.env['JIRA_BASE_URL'],
                // Left as ${VAR} so the token never lands in the temp config file.
                email: '${JIRA_EMAIL}',
                apiToken: '${JIRA_API_TOKEN}',
                project: process.env['JIRA_TEST_PROJECT'],
                issueTypes: {
                  item: process.env['JIRA_TEST_ITEM_TYPE'],
                  task: process.env['JIRA_TEST_TASK_TYPE'],
                },
                dependencyLinkType: process.env['JIRA_TEST_LINK_TYPE'],
              },
            },
            workflow: jiraWorkflow(),
          },
        },
      ]
    : []),
]

const config: PlaywrightTestConfig = defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? 'github' : 'list',
  projects: trackers.map((t) => ({
    name: t.name,
    use: { baseURL: `http://localhost:${t.web}`, browserName: 'chromium' },
  })),
  webServer: trackers.flatMap((t) => [
    {
      command: `node ${join(repoRoot, 'packages/server/dist/index.mjs')} --config ${engine(t.name, t.api, t.config)}`,
      url: `http://127.0.0.1:${t.api}/api/health`,
      cwd: repoRoot,
    },
    {
      command: `pnpm exec vp dev --port ${t.web} --strictPort`,
      url: `http://localhost:${t.web}`,
      env: { TASUKI_API_URL: `http://127.0.0.1:${t.api}` },
    },
  ]),
})

export default config
