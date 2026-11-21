import type { Clock } from './ports/clock'
import type { RunnerPort } from './ports/runner'
import type { StoragePort } from './ports/storage'
import type { StatusMap } from './status-map'

export const API_VERSION = 1

export interface PluginContext {
  clock: Clock
  // The folder the config file is in; relative paths in plugin options resolve against it.
  configDir: string
  dataDir: string
  statuses: StatusMap
}

export type TrackerFactory = (
  ctx: PluginContext,
  options: unknown,
) => StoragePort | Promise<StoragePort>

export type RunnerFactory = (
  ctx: PluginContext,
  options: unknown,
) => RunnerPort | Promise<RunnerPort>

export interface Plugin {
  name: string
  apiVersion: number
  tracker?: TrackerFactory
  runner?: RunnerFactory
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin
}
