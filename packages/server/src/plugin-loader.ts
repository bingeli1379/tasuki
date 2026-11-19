import { API_VERSION, type Plugin, type PluginContext, type StoragePort } from '@tasuki/core'
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
export async function loadTracker(
  name: string,
  options: unknown,
  configDir: string,
  ctx: PluginContext,
): Promise<StoragePort> {
  const entry = await step(name, 'resolve', () =>
    createRequire(join(configDir, 'package.json')).resolve(name),
  )
  const mod = await step(
    name,
    'import',
    () => import(pathToFileURL(entry).href) as Promise<{ default?: Plugin }>,
  )
  const plugin = await step(name, 'check export', () => {
    const p = mod.default
    if (typeof p?.name !== 'string' || typeof p.apiVersion !== 'number') {
      throw new Error('default export is not a definePlugin(...) result')
    }
    if (p.apiVersion !== API_VERSION)
      throw new Error(`apiVersion ${p.apiVersion}, engine expects ${API_VERSION}`)
    if (p.tracker === undefined) throw new Error('does not provide a tracker')
    return { ...p, tracker: p.tracker }
  })
  return step(name, 'create tracker', () => plugin.tracker(ctx, options))
}
