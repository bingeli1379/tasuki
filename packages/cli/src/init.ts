import * as p from '@clack/prompts'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

class Cancelled extends Error {}

// Ctrl+C at any question ends init without writing anything.
function answered<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new Cancelled('init cancelled: nothing was written')
  return value as Exclude<T, symbol>
}

const required = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? 'required' : undefined

interface JiraType {
  id: string
  name: string
  subtask: boolean
  hierarchyLevel?: number
}

interface Jira {
  baseUrl: string
  email: string
  apiToken: string
  project: string
  item: JiraType
  task: JiraType
  link: { id: string; name: string }
}

// Asks until Jira accepts the credentials and knows the project, then looks the ids up, so
// nobody copies them out of Jira by hand (D50).
async function askJira(fetchFn: typeof fetch): Promise<Jira> {
  const spin = p.spinner()
  let baseUrl: string
  let email: string
  let apiToken: string
  let get: (path: string) => Promise<Response>
  for (;;) {
    baseUrl = answered(
      await p.text({
        message: 'Jira URL',
        placeholder: 'https://<site>.atlassian.net',
        validate: (v) =>
          /^https?:\/\/\S+$/.test(v ?? '') ? undefined : 'a URL starting with https://',
      }),
    ).replace(/\/+$/, '')
    email = answered(await p.text({ message: 'Jira email', validate: required }))
    apiToken = answered(
      await p.password({
        message: 'Jira API token',
        validate: required,
      }),
    )
    const authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
    get = (path) =>
      fetchFn(`${baseUrl}${path}`, {
        headers: { Authorization: authorization, Accept: 'application/json' },
      })
    spin.start('signing in to Jira')
    const me = await get('/rest/api/3/myself').catch((e: unknown) => e)
    if (me instanceof Response && me.ok) {
      spin.stop('signed in to Jira')
      break
    }
    spin.error(
      me instanceof Response
        ? `Jira answered ${me.status}: check the URL, the email and the token`
        : `cannot reach ${baseUrl}: ${String(me)}`,
    )
  }
  let project: string
  let types: JiraType[]
  for (;;) {
    project = answered(
      await p.text({ message: 'Project key', placeholder: 'KAN', validate: required }),
    ).toUpperCase()
    spin.start(`looking up project ${project}`)
    const res = await get(`/rest/api/3/project/${encodeURIComponent(project)}`)
    if (res.ok) {
      types = ((await res.json()) as { issueTypes: JiraType[] }).issueTypes
      spin.stop(`found project ${project}`)
      break
    }
    spin.error(`Jira answered ${res.status} for project ${project}`)
  }
  // Epics sit above the standard level and are not where work items go.
  const items = types.filter((t) => !t.subtask && (t.hierarchyLevel ?? 0) === 0)
  const tasks = types.filter((t) => t.subtask)
  if (items.length === 0 || tasks.length === 0)
    throw new Error(`project ${project} needs a standard issue type and a sub-task type`)
  const option = (t: JiraType) => ({ value: t, label: t.name, hint: t.id })
  const item = answered(
    await p.select({ message: 'Issue type for items', options: items.map(option) }),
  )
  const task = answered(
    await p.select({ message: 'Sub-task type for tasks', options: tasks.map(option) }),
  )
  const links = (
    (await (await get('/rest/api/3/issueLinkType')).json()) as {
      issueLinkTypes: { id: string; name: string; outward: string }[]
    }
  ).issueLinkTypes
  const blocks = links.find((l) => l.name === 'Blocks')
  const link =
    blocks ??
    answered(
      await p.select({
        message: 'No "Blocks" link type. Which one means "blocks"?',
        options: links.map((l) => ({ value: l, label: l.name, hint: l.outward })),
      }),
    )
  if (blocks !== undefined) p.log.info(`dependencies use the Blocks link type (${blocks.id})`)
  return { baseUrl, email, apiToken, project, item, task, link }
}

const ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git:*)', 'Bash(node:*)']
const AGENTS = {
  claude: [
    '    "claude": {',
    '      "plugin": "@tasuki/claude-cli",',
    `      "options": { "allowedTools": ${JSON.stringify(ALLOWED_TOOLS)} },`,
    '    },',
  ],
  // Codex has no per-tool list: the sandbox is what its shell commands may touch.
  codex: [
    '    "codex": { "plugin": "@tasuki/codex-cli", "options": { "sandbox": "workspace-write" } },',
  ],
  fake: ['    "fake": { "plugin": "@tasuki/fake-runner", "options": { "seconds": 10 } },'],
}

function trackerLines(jira: Jira | undefined): string[] {
  if (jira === undefined)
    return ['  "tracker": { "plugin": "@tasuki/sqlite", "options": { "refPrefix": "TSK" } },']
  const s = JSON.stringify
  return [
    '  // Statuses are picked on the settings page; until every one is, no agent starts.',
    '  "tracker": {',
    '    "plugin": "@tasuki/jira-cloud",',
    '    "options": {',
    `      "baseUrl": ${s(jira.baseUrl)},`,
    '      "email": "${JIRA_EMAIL}",',
    '      "apiToken": "${JIRA_API_TOKEN}",',
    `      "project": ${s(jira.project)},`,
    '      "issueTypes": {',
    `        "item": ${s(jira.item.id)}, // ${jira.item.name}`,
    `        "task": ${s(jira.task.id)}, // ${jira.task.name}`,
    '      },',
    `      "dependencyLinkType": ${s(jira.link.id)}, // ${jira.link.name}`,
    '    },',
    '  },',
  ]
}

function writeEnv(file: string, values: Record<string, string>): void {
  const kept = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l !== '' && !Object.keys(values).some((k) => l.startsWith(`${k}=`)))
    : []
  const lines = [...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)]
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

// `tasuki init`: asks what the instance runs on and writes the config, and the Jira secrets
// into the .env next to it (D49). An existing config is never overwritten.
export async function init(configPath: string, fetchFn: typeof fetch = fetch): Promise<void> {
  if (existsSync(configPath)) throw new Error(`${configPath} already exists: init leaves it alone`)
  p.intro('tasuki init')
  try {
    const tracker = answered(
      await p.select({
        message: 'Where do the items live?',
        options: [
          { value: 'sqlite', label: 'sqlite', hint: 'a board kept in this folder' },
          { value: 'jira', label: 'Jira Cloud' },
        ],
      }),
    )
    const jira = tracker === 'jira' ? await askJira(fetchFn) : undefined
    const agents = answered(
      await p.multiselect({
        message: 'Which agents? (space to pick)',
        options: [
          {
            value: 'claude' as const,
            label: 'claude',
            hint: "the claude CLI with this machine's login",
          },
          {
            value: 'codex' as const,
            label: 'codex',
            hint: "the codex CLI with this machine's login",
          },
          { value: 'fake' as const, label: 'fake', hint: 'tries the flow without an LLM' },
        ],
        required: true,
      }),
    )
    const auth = answered(
      await p.select({
        message: 'Sign-in',
        options: [
          { value: false, label: 'none', hint: 'only this machine reaches the board' },
          {
            value: true,
            label: 'auth-builtin',
            hint: 'accounts kept in tasuki, the first admin from the setup token',
          },
        ],
      }),
    )
    const lines = [
      '{',
      '  // Written by tasuki init. Relative paths resolve against this folder; ${VAR} expands',
      '  // from the environment and the .env next to this file.',
      '  "version": 1,',
      '  "dataDir": "./data",',
      '  "server": { "host": "127.0.0.1", "port": 8787 },',
      ...trackerLines(jira),
      '  // Rules on the settings page pick an agent by name.',
      '  "agents": {',
      ...agents.flatMap((a) => AGENTS[a]),
      '  },',
      ...(auth
        ? ['  "auth": { "plugin": "@tasuki/auth-builtin", "session": { "ttl": "7d" } },']
        : []),
      '}',
    ]
    writeFileSync(configPath, `${lines.join('\n')}\n`)
    const shown = (file: string): string => relative(process.cwd(), file) || file
    const written = [shown(configPath)]
    if (jira !== undefined) {
      const env = join(dirname(configPath), '.env')
      writeEnv(env, { JIRA_EMAIL: jira.email, JIRA_API_TOKEN: jira.apiToken })
      written.push(`${shown(env)}  JIRA_EMAIL, JIRA_API_TOKEN; keep it out of git`)
    }
    p.note(written.join('\n'), 'Written')
    p.outro('next: tasuki doctor, then tasuki start')
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e
    p.cancel(e.message)
  }
}
