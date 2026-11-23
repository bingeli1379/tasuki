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

// Polling every 2 seconds keeps the Jira run short; the agent takes 10, longer than the board
// needs to read itself again and show it Running.
const engineFile = {
  poll: { intervalSeconds: 2 },
  agents: { fake: { plugin: '@tasuki/fake-runner', options: { seconds: 10 } } },
}

// Rules split, execute and rework on the fake runner (S4, S6, S7b), and an AI review station
// whose rule sends the item one of two ways (W2). Flow settings live in the store (D91), so
// flow.setup.ts saves them through the API before the board tests start.
const rules = [
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
  // M2 (S13): the engine runs each task on its own, at a station of its own so execute keeps
  // in-progress. KAN has no such status, so the Jira flow leaves it out.
  {
    id: 'dispatch',
    watch: 'parallel',
    agent: 'fake',
    mode: 'dispatch',
    outcomes: { succeeded: 'in-review', blocked_manual: 'blocked' },
  },
]

function engine(name: string, port: number, config: object): string {
  const file = join(dir, `${name}.config.jsonc`)
  writeFileSync(
    file,
    JSON.stringify({ dataDir: `./${name}`, server: { port }, ...engineFile, ...config }),
  )
  return file
}

// Statuses of its own on top of the default ten, after Done so no drag in the other tests
// has further to go.
const stations = [
  ...DEFAULT_WORKFLOW.statuses,
  { id: 'triage', handledBy: 'person', outcomes: ['ready-to-split'] },
  { id: 'ai-review', name: 'AI Review' },
  { id: 'parallel' },
  // W5 (D104): one more station on Refining's tracker status.
  { id: 'split-done' },
]

// Stations keyed to another one's tracker status.
const sharing: Record<string, string> = { 'split-done': 'refining' }

// Keyed by the KAN status ids the env maps each logical name to.
function jiraWorkflow(): object {
  const keys: Record<string, string> = JSON.parse(String(process.env['JIRA_TEST_ITEM_STATUSES']))
  return {
    statuses: stations
      .filter((s) => keys[sharing[s.id] ?? s.id] !== undefined)
      .map((s) => ({ ...s, key: keys[sharing[s.id] ?? s.id] })),
    roles: DEFAULT_WORKFLOW.roles,
    taskStatuses: JSON.parse(String(process.env['JIRA_TEST_TASK_STATUSES'])),
  }
}

const trackers = [
  {
    name: 'sqlite',
    api: 8788,
    web: 5180,
    config: {},
    flow: {
      workflow: {
        statuses: stations.map((s) => (sharing[s.id] ? { ...s, key: sharing[s.id] } : s)),
        roles: DEFAULT_WORKFLOW.roles,
      },
      rules,
    },
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
          },
          flow: {
            workflow: jiraWorkflow(),
            rules: rules.filter((r) => r.mode !== 'dispatch'),
          },
        },
      ]
    : []),
]

// Signing in on its own engine (S9, D89): the board tests run with nobody signing in. It
// starts from an empty store, so the setup token is in its data folder.
const signIn = {
  name: 'auth',
  api: 8790,
  web: 5182,
  config: { auth: { plugin: '@tasuki/auth-builtin' } },
  testMatch: 'sign-in.spec.ts',
}
process.env['TASUKI_E2E_AUTH_DATA'] = join(dir, signIn.name)

// Signing in through an outside system (S9c), which a small fake service plays.
const SIGN_IN_SERVICE = 8792
const signInHttp = {
  name: 'auth-http',
  api: 8791,
  web: 5183,
  config: {
    auth: {
      plugin: '@tasuki/auth-http',
      options: { url: `http://127.0.0.1:${SIGN_IN_SERVICE}/check` },
    },
  },
  testMatch: 'sign-in-http.spec.ts',
}
process.env['TASUKI_E2E_AUTH_HTTP_DATA'] = join(dir, signInHttp.name)

const SIGN_IN_SPECS = ['sign-in.spec.ts', 'sign-in-http.spec.ts']
const engines = [
  ...trackers.map((t) => ({ ...t, testIgnore: SIGN_IN_SPECS })),
  ...[signIn, signInHttp].filter((e) => picked.length === 0 || picked.includes(e.name)),
]
const services =
  picked.length === 0 || picked.includes(signInHttp.name)
    ? [
        {
          command: `node ${join(import.meta.dirname, 'e2e/fake-sign-in-service.ts')} ${SIGN_IN_SERVICE}`,
          url: `http://127.0.0.1:${SIGN_IN_SERVICE}/`,
        },
      ]
    : []

const config: PlaywrightTestConfig = defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? 'github' : 'list',
  projects: [
    // Each tracker's engine starts on the default flow; this saves the one its tests need.
    ...trackers.map((t) => ({
      name: `${t.name}-flow`,
      testMatch: 'flow.setup.ts',
      use: { baseURL: `http://localhost:${t.web}` },
      metadata: { flow: t.flow },
    })),
    ...[...trackers, signIn, signInHttp].map((t) => ({
      name: t.name,
      use: { baseURL: `http://localhost:${t.web}`, browserName: 'chromium' as const },
      ...('testMatch' in t
        ? { testMatch: t.testMatch }
        : { testIgnore: SIGN_IN_SPECS, dependencies: [`${t.name}-flow`] }),
    })),
  ],
  webServer: [
    ...services,
    ...engines.flatMap((t) => [
      {
        command: `node ${join(repoRoot, 'packages/cli/dist/index.mjs')} start --config ${engine(t.name, t.api, t.config)}`,
        url: `http://127.0.0.1:${t.api}/api/health`,
        cwd: repoRoot,
      },
      {
        command: `pnpm exec vp dev --port ${t.web} --strictPort`,
        url: `http://localhost:${t.web}`,
        env: { TASUKI_API_URL: `http://127.0.0.1:${t.api}` },
      },
    ]),
  ],
})

export default config
