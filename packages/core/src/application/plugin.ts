import type { AuthPort } from './ports/auth'
import type { Clock } from './ports/clock'
import type { RunnerPort } from './ports/runner'
import type { StorePort } from './ports/store'
import type { TrackerPort } from './ports/tracker'
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
) => TrackerPort | Promise<TrackerPort>

export type StoreFactory = (ctx: PluginContext, options: unknown) => StorePort | Promise<StorePort>

export type RunnerFactory = (
  ctx: PluginContext,
  options: unknown,
) => RunnerPort | Promise<RunnerPort>

// auth-builtin keeps its accounts in the engine's store.
export interface AuthContext extends PluginContext {
  store: StorePort
}

export type AuthFactory = (ctx: AuthContext, options: unknown) => AuthPort | Promise<AuthPort>

// One field of the form the settings page draws for a plugin's options (D105).
export interface OptionField {
  // A dot path into the options, e.g. issueTypes.item.
  key: string
  label: string
  // A secret is kept encrypted and never shown again once saved (D106). A list is strings,
  // one per line on the page; json is any JSON value, an object for most.
  type: 'text' | 'textarea' | 'secret' | 'select' | 'list' | 'json'
  required?: boolean
  description?: string
  placeholder?: string
  // The choices of a select that are known without looking anything up.
  choices?: OptionChoice[]
}

export interface OptionChoice {
  value: string
  label: string
}

export interface OptionsForm {
  fields: OptionField[]
  // The choices of the select fields, looked up from what is filled in so far, e.g. a Jira
  // project's issue types once its address and token are in. Keyed by field key; throws, with
  // a message for the person filling the form, when what is filled cannot find them.
  choices?: (options: unknown) => Promise<Record<string, OptionChoice[]>>
  // A runner's: how "allow always" on a call a person was asked about goes into its options,
  // the list field and the entry, e.g. claude's allowedTools and Bash(git push). Without it a
  // call can only be allowed once (D107).
  allow?: (call: { tool: string; input: unknown }) => { key: string; entry: string }
}

export interface Plugin {
  name: string
  apiVersion: number
  tracker?: TrackerFactory
  store?: StoreFactory
  runner?: RunnerFactory
  auth?: AuthFactory
  // How the settings page asks for each role's options; a role without one gets no form.
  forms?: { tracker?: OptionsForm; runner?: OptionsForm }
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin
}
