import { defineConfig, type PlaywrightTestConfig } from '@playwright/test'
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
]
const withJira = jiraVars.every((v) => process.env[v])

// Workers load this file again; reuse the folder the main process made.
process.env['TASUKI_E2E_DIR'] ??= mkdtempSync(join(tmpdir(), 'tasuki-e2e-'))
const dir = process.env['TASUKI_E2E_DIR']

function engine(name: string, port: number, config: object): string {
  const file = join(dir, `${name}.config.jsonc`)
  writeFileSync(file, JSON.stringify({ dataDir: `./${name}`, server: { port }, ...config }))
  return file
}

const trackers = [
  { name: 'sqlite', api: 8788, web: 5180, config: {} },
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
                issueTypes: { item: process.env['JIRA_TEST_ITEM_TYPE'] },
              },
            },
            statuses: { item: JSON.parse(String(process.env['JIRA_TEST_ITEM_STATUSES'])) },
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
