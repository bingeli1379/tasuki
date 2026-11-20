import {
  API_VERSION,
  type Plugin,
  type PluginContext,
  type RunnerPort,
  type StoragePort,
} from '@tasuki/core'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function step<T>(plugin: string, what: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    throw new Error(`plugin "${plugin}": ${what}: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    })
  }
}

// Plugins resolve from the config's folder, the way a project resolves its own dependencies.
// Any failure refuses to start (D48).
async function load<R extends 'tracker' | 'runner'>(
  name: string,
  configDir: string,
  role: R,
): Promise<NonNullable<Plugin[R]>> {
  const entry = await step(name, 'resolve', () =>
    createRequire(join(configDir, 'package.json')).resolve(name),
  )
  const mod = await step(
    name,
    'import',
    () => import(pathToFileURL(entry).href) as Promise<{ default?: Plugin }>,
  )
  return step(name, 'check export', () => {
    const p = mod.default
    if (typeof p?.name !== 'string' || typeof p.apiVersion !== 'number') {
      throw new Error('default export is not a definePlugin(...) result')
    }
    if (p.apiVersion !== API_VERSION)
      throw new Error(`apiVersion ${p.apiVersion}, engine expects ${API_VERSION}`)
    const factory = p[role]
    if (factory === undefined) throw new Error(`does not provide a ${role}`)
    return factory
  })
}

export async function loadTracker(
  name: string,
  options: unknown,
  configDir: string,
  ctx: PluginContext,
): Promise<StoragePort> {
  const tracker = await load(name, configDir, 'tracker')
  return step(name, 'create tracker', () => tracker(ctx, options))
}

export async function loadRunner(
  name: string,
  options: unknown,
  configDir: string,
  ctx: PluginContext,
): Promise<RunnerPort> {
  const runner = await load(name, configDir, 'runner')
  return step(name, 'create runner', () => runner(ctx, options))
}
