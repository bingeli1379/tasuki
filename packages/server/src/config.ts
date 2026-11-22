import {
  DEFAULT_WORKFLOW,
  ENGINE_OUTCOMES,
  MODE_OUTCOMES,
  TASK_STATUS_DISPLAY,
  TASK_STATUSES,
  type Roles,
  type Rule,
  type RuleMode,
  type RuleSession,
  type Station,
  type StatusMapping,
  type Workflow,
} from '@tasuki/core'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseJsonc } from './jsonc'
import { defaultPrompt } from './prompts'

export interface PluginRef {
  plugin: string
  options: unknown
}

export interface Limits {
  maxConcurrentRuns: number
  leaseSeconds: number
  defaultMaxAttempts: number
  // A soft cancel turns hard after this long; a hard one sends SIGKILL after this long.
  softGraceSeconds: number
  hardGraceSeconds: number
}

export interface AuthConfig extends PluginRef {
  // As written, e.g. "7d" or "never": a session issued under another value is over (D89).
  ttl: string
  // Unset for never.
  ttlSeconds?: number
}

export interface Config {
  configDir: string
  dataDir: string
  port: number
  tracker: PluginRef
  // Where the engine keeps its Runs and the pause (D78).
  store: PluginRef
  workflow: Workflow
  // What the tracker plugin is handed: each station's and task status's tracker key.
  statuses: StatusMapping
  pollSeconds: number
  limits: Limits
  // The label that keeps the engine off an item.
  holdLabel: string
  agents: Record<string, PluginRef>
  rules: Rule[]
  // Unset: nobody signs in (security-and-auth.md).
  auth?: AuthConfig
}

type Raw = Record<string, unknown>

const MODES = Object.keys(MODE_OUTCOMES) as RuleMode[]
const SESSIONS: readonly RuleSession[] = ['fresh', 'per-item']

const ROLES: readonly (keyof Roles)[] = ['entry', 'failure']

const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const titleCase = (id: string): string =>
  id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

// The stations, their roles and the tracker keys of them and of the task statuses
// (config-and-rules.md). Rules are checked against it after.
function parseWorkflow(
  value: unknown,
  claimed: readonly unknown[],
): { workflow: Workflow; statuses: StatusMapping } {
  if (value === undefined) {
    // Only a rule's claim ever puts an item in splitting, and the default rules claim
    // nothing (D74): unclaimed, its column would never fill.
    const stations = DEFAULT_WORKFLOW.statuses.filter(
      (s) => s.id !== 'splitting' || claimed.includes(s.id),
    )
    return {
      workflow: { ...DEFAULT_WORKFLOW, statuses: stations },
      // sqlite stores the display names.
      statuses: {
        item: Object.fromEntries(stations.map((s) => [s.id, s.name])),
        task: TASK_STATUS_DISPLAY,
      },
    }
  }
  if (!isObject(value)) throw new Error('config workflow must be an object')
  const list = value['statuses']
  if (!Array.isArray(list) || list.length === 0)
    throw new Error('config workflow.statuses must list at least one status')
  const keys: Record<string, string> = {}
  const stations = list.map((raw: unknown, index): Station => {
    const path = `workflow.statuses[${index}]`
    if (!isObject(raw)) throw new Error(`config ${path} must be an object`)
    const id = raw['id']
    // Logical names are kebab-case (CLAUDE.md); display names come from name.
    if (typeof id !== 'string' || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id))
      throw new Error(`config ${path}.id must be a kebab-case name such as ai-review`)
    if (keys[id] !== undefined) throw new Error(`config workflow.statuses: ${id} is listed twice`)
    const name = raw['name'] ?? titleCase(id)
    if (typeof name !== 'string' || name === '')
      throw new Error(`config ${path} (${id}).name must be text`)
    const key = raw['key'] ?? name
    if (typeof key !== 'string' || key === '')
      throw new Error(`config ${path} (${id}).key must be the tracker's status`)
    keys[id] = key
    const handledBy = raw['handledBy']
    if (handledBy !== undefined && handledBy !== 'person')
      throw new Error(
        `config ${path} (${id}).handledBy can only be person; a rule watching it makes it the engine's`,
      )
    const outcomes: unknown = raw['outcomes'] ?? []
    if (!Array.isArray(outcomes) || outcomes.some((to) => typeof to !== 'string'))
      throw new Error(`config ${path} (${id}).outcomes must list statuses`)
    if (new Set(outcomes).size !== outcomes.length)
      throw new Error(`config ${path} (${id}).outcomes lists a status twice`)
    return {
      id,
      name,
      ...(handledBy === undefined ? {} : { handledBy }),
      outcomes: outcomes as string[],
    }
  })
  const owners = Object.entries(keys).filter(([, k], i, all) =>
    all.some(([, other], j) => j !== i && other === k),
  )
  if (owners.length > 0)
    throw new Error(
      `config workflow.statuses: ${owners.map(([id]) => id).join(' and ')} share the tracker key ${owners[0]?.[1]}`,
    )
  for (const station of stations)
    for (const to of station.outcomes) {
      if (keys[to] === undefined)
        throw new Error(
          `config workflow.statuses (${station.id}).outcomes: status "${to}" is not in workflow.statuses`,
        )
      if (to === station.id)
        throw new Error(
          `config workflow.statuses (${station.id}).outcomes: ${to} must be another status`,
        )
    }

  const rawRoles = value['roles']
  if (!isObject(rawRoles)) throw new Error('config workflow.roles is required')
  for (const role of Object.keys(rawRoles))
    if (!ROLES.includes(role as keyof Roles))
      throw new Error(`config workflow.roles.${role}: not a role (${ROLES.join(', ')})`)
  for (const role of ROLES)
    if (rawRoles[role] === undefined) throw new Error(`config workflow.roles.${role} is required`)
  for (const [role, id] of Object.entries(rawRoles))
    if (typeof id !== 'string' || keys[id] === undefined)
      throw new Error(
        `config workflow.roles.${role}: status "${String(id)}" is not in workflow.statuses`,
      )

  const tasks = value['taskStatuses'] ?? TASK_STATUS_DISPLAY
  if (!isObject(tasks)) throw new Error('config workflow.taskStatuses must be an object')
  const unknown = Object.keys(tasks).filter((s) => !TASK_STATUSES.includes(s))
  if (unknown.length > 0)
    throw new Error(`config workflow.taskStatuses: unknown status ${unknown.join(', ')}`)
  return {
    workflow: { statuses: stations, roles: rawRoles as unknown as Roles },
    statuses: { item: keys, task: tasks as Record<string, string> },
  }
}

function positive(raw: Raw, key: string, fallback: number, path: string): number {
  const value = raw[key] ?? fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new Error(`config ${path}.${key} must be a whole number of at least 1`)
  return value
}

function pluginRef(value: unknown, path: string): PluginRef {
  if (!isObject(value) || typeof value['plugin'] !== 'string')
    throw new Error(`config ${path}.plugin must be a package name`)
  return { plugin: value['plugin'], options: value['options'] ?? {} }
}

const UNIT_SECONDS = { m: 60, h: 3600, d: 86400 } as const

function parseAuth(value: unknown): AuthConfig | undefined {
  if (value === undefined) return undefined
  const ref = pluginRef(value, 'auth')
  const session = isObject(value) && isObject(value['session']) ? value['session'] : {}
  const ttl = session['ttl'] ?? '7d'
  if (ttl === 'never') return { ...ref, ttl }
  const match = typeof ttl === 'string' ? /^([1-9]\d*)([mhd])$/.exec(ttl) : null
  if (typeof ttl !== 'string' || match === null)
    throw new Error('config auth.session.ttl must be a length such as 30m, 24h, 7d, or "never"')
  const unit = match[2] as keyof typeof UNIT_SECONDS
  return { ...ref, ttl, ttlSeconds: Number(match[1]) * UNIT_SECONDS[unit] }
}

// The checks doctor also runs on rules (config-and-rules.md, 1 to 5 and 11).
function parseRules(
  value: unknown,
  mapped: readonly string[],
  agents: Record<string, PluginRef>,
  defaultMaxAttempts: number,
  configDir: string,
  failure: string,
): Rule[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('config rules must be a list')
  const rules = value.map((raw: unknown, index): Rule => {
    if (!isObject(raw)) throw new Error(`config rules[${index}] must be an object`)
    const path = `rules[${index}]${typeof raw['id'] === 'string' ? ` (${raw['id']})` : ''}`
    const text = (key: string): string => {
      const v = raw[key]
      if (typeof v !== 'string' || v === '') throw new Error(`config ${path}.${key} is required`)
      return v
    }
    const status = (key: string, v: string): string => {
      if (!mapped.includes(v))
        throw new Error(`config ${path}.${key}: status "${v}" is not in workflow.statuses`)
      return v
    }
    const id = text('id')
    const watch = status('watch', text('watch'))
    const claim = raw['claim'] === undefined ? undefined : status('claim', text('claim'))
    if (claim === watch) throw new Error(`config ${path}.claim must differ from watch`)
    const agent = text('agent')
    if (agents[agent] === undefined)
      throw new Error(`config ${path}.agent: no agent "${agent}" in agents`)
    const mode = text('mode') as RuleMode
    if (!MODES.includes(mode))
      throw new Error(`config ${path}.mode must be one of ${MODES.join(', ')}`)
    const rawOutcomes = raw['outcomes'] ?? {}
    if (!isObject(rawOutcomes)) throw new Error(`config ${path}.outcomes must be an object`)
    const outcomes: Rule['outcomes'] = {}
    for (const [name, target] of Object.entries(rawOutcomes)) {
      // The agent reports these names, so they read like the built-in ones.
      if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name))
        throw new Error(`config ${path}.outcomes.${name}: a name such as needs_design`)
      if (name === 'cancelled' || name === 'abandoned')
        throw new Error(`config ${path}.outcomes.${name}: the item does not move on it`)
      if (typeof target !== 'string')
        throw new Error(`config ${path}.outcomes.${name} must be a status`)
      outcomes[name] = status(`outcomes.${name}`, target)
    }
    for (const name of MODE_OUTCOMES[mode])
      if (outcomes[name] === undefined)
        throw new Error(`config ${path}.outcomes.${name} is required in ${mode} mode`)
    if (Object.keys(outcomes).every((name) => ENGINE_OUTCOMES.includes(name)))
      throw new Error(`config ${path}.outcomes must name at least one way for the agent to finish`)
    // Every rule can end on these; they go to the failure station unless it says otherwise.
    for (const name of ENGINE_OUTCOMES) outcomes[name] ??= failure
    if (raw['prompt'] !== undefined && raw['promptFile'] !== undefined)
      throw new Error(`config ${path}: set prompt or promptFile, not both`)
    let prompt = defaultPrompt(mode)
    if (raw['prompt'] !== undefined) prompt = text('prompt')
    if (raw['promptFile'] !== undefined) {
      const file = resolve(configDir, text('promptFile'))
      if (!existsSync(file)) throw new Error(`config ${path}.promptFile: ${file} does not exist`)
      prompt = readFileSync(file, 'utf8')
    }
    const session = (raw['session'] ?? 'fresh') as RuleSession
    if (!SESSIONS.includes(session))
      throw new Error(`config ${path}.session must be one of ${SESSIONS.join(', ')}`)
    return {
      id,
      watch,
      ...(claim === undefined ? {} : { claim }),
      agent,
      mode,
      maxAttempts: positive(raw, 'maxAttempts', defaultMaxAttempts, path),
      outcomes,
      prompt,
      session,
    }
  })
  for (const [i, rule] of rules.entries()) {
    const other = rules.findIndex((r, j) => j !== i && (r.id === rule.id || r.watch === rule.watch))
    if (other > i)
      throw new Error(
        rules[other]?.id === rule.id
          ? `config rules: two rules are called ${rule.id}`
          : `config rules: ${rule.id} and ${rules[other]?.id} both watch ${rule.watch}`,
      )
  }
  return rules
}

function expandEnv(value: unknown, path: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const v = process.env[name]
      if (v === undefined)
        throw new Error(`config ${path}: environment variable ${name} is not set`)
      return v
    })
  }
  if (Array.isArray(value)) return value.map((v, i) => expandEnv(v, `${path}[${i}]`))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, expandEnv(v, path ? `${path}.${k}` : k)]),
    )
  }
  return value
}

export function loadConfig(path: string): Config {
  const file = resolve(path)
  if (!existsSync(file)) throw new Error(`config file not found: ${file}`)
  const configDir = dirname(file)
  // Variables already in the environment win over .env (D49).
  const envFile = join(configDir, '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)

  const raw = expandEnv(parseJsonc(readFileSync(file, 'utf8')), '') as Raw
  const server = (raw['server'] ?? {}) as Raw
  const tracker = pluginRef(raw['tracker'] ?? { plugin: '@tasuki/sqlite' }, 'tracker')
  const store = pluginRef(raw['store'] ?? { plugin: '@tasuki/sqlite' }, 'store')

  const claimed = (Array.isArray(raw['rules']) ? raw['rules'] : []).map((r: unknown) =>
    isObject(r) ? r['claim'] : undefined,
  )
  const { workflow: parsed, statuses } = parseWorkflow(raw['workflow'], claimed)

  const rawLimits = isObject(raw['limits']) ? raw['limits'] : {}
  const limits: Limits = {
    maxConcurrentRuns: positive(rawLimits, 'maxConcurrentRuns', 2, 'limits'),
    leaseSeconds: positive(rawLimits, 'leaseSeconds', 120, 'limits'),
    defaultMaxAttempts: positive(rawLimits, 'defaultMaxAttempts', 3, 'limits'),
    softGraceSeconds: positive(rawLimits, 'softGraceSeconds', 300, 'limits'),
    hardGraceSeconds: positive(rawLimits, 'hardGraceSeconds', 10, 'limits'),
  }
  const holdLabel = (isObject(raw['labels']) ? raw['labels']['hold'] : undefined) ?? 'hold'
  // Jira labels cannot hold spaces.
  if (typeof holdLabel !== 'string' || !/^\S+$/.test(holdLabel))
    throw new Error('config labels.hold must be one word with no spaces')
  const agents = Object.fromEntries(
    Object.entries(isObject(raw['agents']) ? raw['agents'] : {}).map(([name, agent]) => [
      name,
      pluginRef(agent, `agents.${name}`),
    ]),
  )
  // Jira searches are slower and rate limited, so it is polled less often.
  const pollDefault = tracker.plugin === '@tasuki/jira-cloud' ? 30 : 5

  const rules = parseRules(
    raw['rules'],
    parsed.statuses.map((s) => s.id),
    agents,
    limits.defaultMaxAttempts,
    configDir,
    parsed.roles.failure,
  )
  // Sending work back means leaving feedback for the rework rule's agent, so the station it
  // watches is where the board asks for that feedback (D86).
  const reworkAt = [...new Set(rules.filter((r) => r.mode === 'rework').map((r) => r.watch))]
  if (reworkAt.length > 1)
    throw new Error(`config rules: rework rules must watch one status, not ${reworkAt.join(', ')}`)
  const workflow: Workflow =
    reworkAt[0] === undefined
      ? parsed
      : { ...parsed, roles: { ...parsed.roles, rework: reworkAt[0] } }
  // The tasks a splitting or reworking agent can make start in one of these.
  const splitter = rules.find((r) => r.mode === 'split' || r.mode === 'rework')
  const missing = ['to-do', 'manual'].filter((s) => statuses.task?.[s] === undefined)
  if (splitter !== undefined && missing.length > 0)
    throw new Error(
      `config workflow.taskStatuses must map ${missing.join(', ')}: rule ${splitter.id} makes tasks`,
    )
  // An executing agent walks every task status.
  const executor = rules.find((r) => r.mode === 'execute')
  const unmapped = TASK_STATUSES.filter((s) => statuses.task?.[s] === undefined)
  if (executor !== undefined && unmapped.length > 0)
    throw new Error(
      `config workflow.taskStatuses must map ${unmapped.join(', ')}: rule ${executor.id} runs tasks`,
    )

  return {
    configDir,
    dataDir: resolve(configDir, typeof raw['dataDir'] === 'string' ? raw['dataDir'] : './data'),
    port: typeof server['port'] === 'number' ? server['port'] : 8787,
    tracker,
    store,
    workflow,
    statuses,
    pollSeconds: positive(
      isObject(raw['poll']) ? raw['poll'] : {},
      'intervalSeconds',
      pollDefault,
      'poll',
    ),
    limits,
    holdLabel,
    agents,
    rules,
    ...(raw['auth'] === undefined ? {} : { auth: parseAuth(raw['auth']) as AuthConfig }),
  }
}
