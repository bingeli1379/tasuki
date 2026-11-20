import {
  ITEM_STATUS_DISPLAY,
  ITEM_STATUSES,
  TASK_STATUS_DISPLAY,
  TASK_STATUSES,
  type Rule,
  type RuleExit,
  type RuleMode,
  type StatusMapping,
} from '@tasuki/core'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseJsonc } from './jsonc'

export interface PluginRef {
  plugin: string
  options: unknown
}

export interface Limits {
  maxConcurrentRuns: number
  leaseSeconds: number
  defaultMaxAttempts: number
}

export interface Config {
  configDir: string
  dataDir: string
  port: number
  tracker: PluginRef
  statuses: StatusMapping
  pollSeconds: number
  limits: Limits
  agents: Record<string, PluginRef>
  rules: Rule[]
}

type Raw = Record<string, unknown>

const MODES: readonly RuleMode[] = ['split', 'execute', 'rework']
const EXITS: readonly RuleExit[] = [
  'succeeded',
  'needs_input',
  'blocked_manual',
  'failed',
  'max_attempts',
]

const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

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

// The checks doctor also runs on rules (config-and-rules.md, 1 to 5).
function parseRules(
  value: unknown,
  mapped: readonly string[],
  agents: Record<string, PluginRef>,
  defaultMaxAttempts: number,
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
        throw new Error(`config ${path}.${key}: status "${v}" is not in statuses.item`)
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
    const on: Rule['on'] = {}
    for (const [key, target] of Object.entries(isObject(raw['on']) ? raw['on'] : {})) {
      if (!EXITS.includes(key as RuleExit))
        throw new Error(`config ${path}.on.${key}: not an outcome a rule can move on`)
      if (typeof target !== 'string') throw new Error(`config ${path}.on.${key} must be a status`)
      on[key as RuleExit] = status(`on.${key}`, target)
    }
    // failed and max_attempts default to blocked; blocked_manual cannot come from a split.
    const needed: RuleExit[] =
      mode === 'execute'
        ? ['succeeded', 'needs_input', 'blocked_manual']
        : ['succeeded', 'needs_input']
    for (const key of needed)
      if (on[key] === undefined) throw new Error(`config ${path}.on.${key} is required`)
    for (const key of ['failed', 'max_attempts'] as const)
      if (on[key] === undefined) status(`on.${key} (default)`, 'blocked')
    return {
      id,
      watch,
      ...(claim === undefined ? {} : { claim }),
      agent,
      mode,
      maxAttempts: positive(raw, 'maxAttempts', defaultMaxAttempts, path),
      on,
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

  // Without a mapping, sqlite stores the display names (config-and-rules.md example).
  const statuses = (raw['statuses'] ?? {
    item: ITEM_STATUS_DISPLAY,
    task: TASK_STATUS_DISPLAY,
  }) as StatusMapping
  for (const [kind, known] of [
    ['item', ITEM_STATUSES],
    ['task', TASK_STATUSES],
  ] as const) {
    const unknown = Object.keys(statuses[kind] ?? {}).filter((s) => !known.includes(s))
    if (unknown.length > 0)
      throw new Error(`config statuses.${kind}: unknown status ${unknown.join(', ')}`)
  }
  if (statuses.item?.['refining'] === undefined) {
    throw new Error('config statuses.item must map refining: new items start there')
  }

  const rawLimits = isObject(raw['limits']) ? raw['limits'] : {}
  const limits: Limits = {
    maxConcurrentRuns: positive(rawLimits, 'maxConcurrentRuns', 2, 'limits'),
    leaseSeconds: positive(rawLimits, 'leaseSeconds', 120, 'limits'),
    defaultMaxAttempts: positive(rawLimits, 'defaultMaxAttempts', 3, 'limits'),
  }
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
    Object.keys(statuses.item ?? {}),
    agents,
    limits.defaultMaxAttempts,
  )
  // The tasks a splitting agent can make start in one of these.
  const splitter = rules.find((r) => r.mode === 'split')
  const missing = ['to-do', 'manual'].filter((s) => statuses.task?.[s] === undefined)
  if (splitter !== undefined && missing.length > 0)
    throw new Error(
      `config statuses.task must map ${missing.join(', ')}: rule ${splitter.id} splits items into tasks`,
    )
  // An executing agent walks every task status.
  const executor = rules.find((r) => r.mode === 'execute')
  const unmapped = TASK_STATUSES.filter((s) => statuses.task?.[s] === undefined)
  if (executor !== undefined && unmapped.length > 0)
    throw new Error(
      `config statuses.task must map ${unmapped.join(', ')}: rule ${executor.id} runs tasks`,
    )

  return {
    configDir,
    dataDir: resolve(configDir, typeof raw['dataDir'] === 'string' ? raw['dataDir'] : './data'),
    port: typeof server['port'] === 'number' ? server['port'] : 8787,
    tracker,
    statuses,
    pollSeconds: positive(
      isObject(raw['poll']) ? raw['poll'] : {},
      'intervalSeconds',
      pollDefault,
      'poll',
    ),
    limits,
    agents,
    rules,
  }
}
