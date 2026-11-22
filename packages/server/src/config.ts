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
  // What the server binds to; anything but loopback needs publicUrl (security-and-auth.md).
  host: string
  port: number
  // The https address people open, behind the proxy that does TLS (D60).
  publicUrl?: string
  tracker: PluginRef
  // Where the engine keeps its Runs, the pause and the flow settings (D78, D91).
  store: PluginRef
  pollSeconds: number
  limits: Limits
  agents: Record<string, PluginRef>
  // Unset: nobody signs in (security-and-auth.md).
  auth?: AuthConfig
}

type Raw = Record<string, unknown>

// The file holds what whoever deploys the engine sets; the flow is in the store (D91).
const FIELDS = [
  '$schema',
  'version',
  'dataDir',
  'server',
  'auth',
  'tracker',
  'store',
  'agents',
  'poll',
  'limits',
  'workspace',
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

export const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)

// An unauthenticated engine on the network lets anyone drive an agent with tool access, and a
// password typed at the login page crosses the network as typed. allowInsecure owns both, for
// a container whose port is only published on the host's loopback (D90).
function checkBinding(server: Raw, hasAuth: boolean): { host: string; publicUrl?: string } {
  const host = server['host'] ?? '127.0.0.1'
  if (typeof host !== 'string' || host === '')
    throw new Error('config server.host must be a string')
  const raw = server['publicUrl']
  let publicUrl: URL | undefined
  if (raw !== undefined) {
    try {
      publicUrl = typeof raw === 'string' ? new URL(raw) : undefined
    } catch {}
    if (publicUrl === undefined) throw new Error('config server.publicUrl must be a URL')
  }
  const binding = publicUrl === undefined ? { host } : { host, publicUrl: publicUrl.origin }
  if (isLoopback(host) || server['allowInsecure'] === true) return binding
  if (!hasAuth)
    throw new Error(
      `config server.host is ${host} with no auth: anyone who reaches it can drive the agents. Set auth, or server.allowInsecure: true`,
    )
  if (publicUrl?.protocol !== 'https:')
    throw new Error(
      `config server.publicUrl must be the https address people open when server.host is ${host}, behind a proxy that does TLS`,
    )
  return binding
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
  if (!existsSync(file))
    throw new Error(`config file not found: ${file}. Run tasuki init there, or pass --config`)
  const configDir = dirname(file)
  // Variables already in the environment win over .env (D49).
  const envFile = join(configDir, '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)

  const raw = expandEnv(parseJsonc(readFileSync(file, 'utf8')), '') as Raw
  for (const key of Object.keys(raw))
    if (!FIELDS.includes(key))
      throw new Error(`config ${key}: not a field of the config file (${FIELDS.join(', ')})`)
  const server = (raw['server'] ?? {}) as Raw
  const tracker = pluginRef(raw['tracker'] ?? { plugin: '@tasuki/sqlite' }, 'tracker')
  const store = pluginRef(raw['store'] ?? { plugin: '@tasuki/sqlite' }, 'store')

  const rawLimits = isObject(raw['limits']) ? raw['limits'] : {}
  const limits: Limits = {
    maxConcurrentRuns: positive(rawLimits, 'maxConcurrentRuns', 2, 'limits'),
    leaseSeconds: positive(rawLimits, 'leaseSeconds', 120, 'limits'),
    defaultMaxAttempts: positive(rawLimits, 'defaultMaxAttempts', 3, 'limits'),
    softGraceSeconds: positive(rawLimits, 'softGraceSeconds', 300, 'limits'),
    hardGraceSeconds: positive(rawLimits, 'hardGraceSeconds', 10, 'limits'),
  }
  const agents = Object.fromEntries(
    Object.entries(isObject(raw['agents']) ? raw['agents'] : {}).map(([name, agent]) => [
      name,
      pluginRef(agent, `agents.${name}`),
    ]),
  )
  // Jira searches are slower and rate limited, so it is polled less often.
  const pollDefault = tracker.plugin === '@tasuki/jira-cloud' ? 30 : 5

  return {
    configDir,
    dataDir: resolve(configDir, typeof raw['dataDir'] === 'string' ? raw['dataDir'] : './data'),
    ...checkBinding(server, raw['auth'] !== undefined),
    port: typeof server['port'] === 'number' ? server['port'] : 8787,
    tracker,
    store,
    pollSeconds: positive(
      isObject(raw['poll']) ? raw['poll'] : {},
      'intervalSeconds',
      pollDefault,
      'poll',
    ),
    limits,
    agents,
    ...(raw['auth'] === undefined ? {} : { auth: parseAuth(raw['auth']) as AuthConfig }),
  }
}
