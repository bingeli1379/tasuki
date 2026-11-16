import { ITEM_STATUS_DISPLAY, ITEM_STATUSES, type StatusMapping } from '@tasuki/core'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseJsonc } from './jsonc'

export interface Config {
  configDir: string
  dataDir: string
  port: number
  tracker: { plugin: string; options: unknown }
  statuses: StatusMapping
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

  const raw = expandEnv(parseJsonc(readFileSync(file, 'utf8')), '') as Record<string, unknown>
  const server = (raw['server'] ?? {}) as Record<string, unknown>
  const tracker = (raw['tracker'] ?? { plugin: '@tasuki/sqlite' }) as Record<string, unknown>
  if (typeof tracker['plugin'] !== 'string')
    throw new Error('config tracker.plugin must be a package name')

  // Without a mapping, sqlite stores the display names (config-and-rules.md example).
  const statuses = (raw['statuses'] ?? { item: ITEM_STATUS_DISPLAY }) as StatusMapping
  const unknown = Object.keys(statuses.item ?? {}).filter((s) => !ITEM_STATUSES.includes(s))
  if (unknown.length > 0)
    throw new Error(`config statuses.item: unknown status ${unknown.join(', ')}`)
  if (statuses.item?.['refining'] === undefined) {
    throw new Error('config statuses.item must map refining: new items start there')
  }

  return {
    configDir,
    dataDir: resolve(configDir, typeof raw['dataDir'] === 'string' ? raw['dataDir'] : './data'),
    port: typeof server['port'] === 'number' ? server['port'] : 8787,
    tracker: { plugin: tracker['plugin'], options: tracker['options'] ?? {} },
    statuses,
  }
}
