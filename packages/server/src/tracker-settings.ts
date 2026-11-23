import {
  assertEditsInstance,
  clearHeartbeat,
  InvalidInput,
  saveInstance,
  unmatchedStatuses,
  withSharedStatuses,
  type Account,
  type OptionChoice,
  type OptionField,
  type OptionsForm,
  type PluginContext,
  type StorePort,
  type TrackerPort,
} from '@tasuki/core'
import type { LiveFlow } from './flow'
import { pollDefaultFor, type LiveInstance } from './instance'
import { loadTracker, loadTrackerForm } from './plugin-loader'
import type { Secrets } from './secrets'

// Which tracker the engine runs on, kept in the store and edited by an admin on the Tracker
// page (D105). Options hold their secrets in the clear here; only the store sees them sealed.
export interface TrackerSettings {
  plugin: string
  options: Record<string, unknown>
}

// Until an admin picks one (D1).
export const DEFAULT_TRACKER: TrackerSettings = { plugin: '@tasuki/sqlite', options: {} }

type Raw = Record<string, unknown>

const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function getPath(options: Raw, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((at, part) => (isObject(at) ? at[part] : undefined), options)
}

// A copy with the value at key set, or removed when value is undefined.
function setPath(options: Raw, key: string, value: unknown): Raw {
  const [head, ...rest] = key.split('.') as [string, ...string[]]
  const copy = { ...options }
  if (rest.length === 0) {
    if (value === undefined) delete copy[head]
    else copy[head] = value
    return copy
  }
  copy[head] = setPath(isObject(copy[head]) ? copy[head] : {}, rest.join('.'), value)
  return copy
}

const secretKeys = (form: OptionsForm | undefined): string[] =>
  (form?.fields ?? []).filter((f) => f.type === 'secret').map((f) => f.key)

function mapSecrets(options: Raw, keys: string[], map: (v: string) => string): Raw {
  let out = options
  for (const key of keys) {
    const v = getPath(options, key)
    if (typeof v === 'string' && v !== '') out = setPath(out, key, map(v))
  }
  return out
}

function withoutSecrets(options: Raw, keys: string[]): Raw {
  let out = options
  for (const key of keys) out = setPath(out, key, undefined)
  return out
}

// What the Tracker page shows: never a secret, only whether it is set.
export interface TrackerView {
  version?: number
  plugin: string
  options: Raw
  secretsSet: string[]
  fields: OptionField[]
  lookup: boolean
}

export interface LiveTracker {
  // Forwards to the tracker in use, so whatever holds it follows a save.
  readonly port: TrackerPort
  current(): TrackerSettings
  view(): Promise<TrackerView>
  // The form of any tracker plugin, for switching to it on the page.
  form(plugin: string): Promise<{ fields: OptionField[]; lookup: boolean }>
  choices(actor: Account, plugin: string, options: unknown): Promise<Record<string, OptionChoice[]>>
  save(
    actor: Account,
    expected: number | undefined,
    plugin: unknown,
    options: unknown,
  ): Promise<number>
}

export interface TrackerDeps {
  store: StorePort
  flow: LiveFlow
  instance: LiveInstance
  secrets: Secrets
  ctx: Omit<PluginContext, 'statuses'>
  engineId: string
  // An error message when another engine already runs the rules on this tracker (D66).
  otherEngine(tracker: TrackerPort): Promise<string | undefined>
}

// The tracker as last saved, its secrets opened, or the default.
export async function readTrackerSettings(
  store: StorePort,
  secrets: Secrets,
  configDir: string,
): Promise<{ settings: TrackerSettings; version?: number }> {
  const latest = await store.latestSettings('tracker')
  if (latest === undefined) return { settings: DEFAULT_TRACKER }
  const value = latest.value as TrackerSettings
  const form = await loadTrackerForm(value.plugin, configDir)
  return {
    settings: {
      plugin: value.plugin,
      options: mapSecrets(value.options, secretKeys(form), (v) => secrets.open(v)),
    },
    version: latest.version,
  }
}

export async function createLiveTracker(
  deps: TrackerDeps,
  initial: { settings: TrackerSettings; version?: number },
): Promise<LiveTracker> {
  const { store, flow, instance, secrets, ctx } = deps
  const build = async (settings: TrackerSettings): Promise<TrackerPort> =>
    withSharedStatuses(
      await loadTracker(settings.plugin, settings.options, ctx.configDir, {
        ...ctx,
        statuses: flow.statuses,
      }),
      store,
      flow.statuses,
    )
  let settings = initial.settings
  let version = initial.version
  let target = await build(settings)
  const port = new Proxy({} as TrackerPort, {
    get: (_, key) => {
      const v = target[key as keyof TrackerPort]
      return typeof v === 'function' ? v.bind(target) : v
    },
    has: (_, key) => key in target,
  })
  const formOf = async (plugin: string) => {
    try {
      return await loadTrackerForm(plugin, ctx.configDir)
    } catch (e) {
      throw new InvalidInput(e instanceof Error ? e.message : String(e))
    }
  }
  // A secret left blank keeps the one in use when the plugin stays the same.
  const filled = (plugin: string, options: Raw, form: OptionsForm | undefined): Raw => {
    let out = options
    for (const key of secretKeys(form)) {
      const v = getPath(options, key)
      if ((v === undefined || v === '') && plugin === settings.plugin)
        out = setPath(out, key, getPath(settings.options, key))
    }
    return out
  }
  return {
    port,
    current: () => settings,
    async view() {
      const form = await loadTrackerForm(settings.plugin, ctx.configDir)
      const secret = secretKeys(form)
      return {
        ...(version === undefined ? {} : { version }),
        plugin: settings.plugin,
        options: withoutSecrets(settings.options, secret),
        secretsSet: secret.filter((k) => getPath(settings.options, k) !== undefined),
        fields: form?.fields ?? [],
        lookup: form?.choices !== undefined,
      }
    },
    async form(plugin) {
      const form = await formOf(plugin)
      return { fields: form?.fields ?? [], lookup: form?.choices !== undefined }
    },
    async choices(actor, plugin, options) {
      assertEditsInstance(actor)
      const form = await formOf(plugin)
      if (form?.choices === undefined) return {}
      try {
        return await form.choices(filled(plugin, isObject(options) ? options : {}, form))
      } catch (e) {
        throw new InvalidInput(e instanceof Error ? e.message : String(e))
      }
    },
    async save(actor, expected, rawPlugin, rawOptions) {
      assertEditsInstance(actor)
      if (typeof rawPlugin !== 'string' || rawPlugin === '')
        throw new InvalidInput('plugin must be a package name')
      if (rawOptions !== undefined && !isObject(rawOptions))
        throw new InvalidInput('options must be an object')
      const form = await formOf(rawPlugin)
      const secret = secretKeys(form)
      const next: TrackerSettings = {
        plugin: rawPlugin,
        options: filled(rawPlugin, rawOptions ?? {}, form),
      }
      for (const field of form?.fields ?? []) {
        const v = getPath(next.options, field.key)
        if (field.required === true && (v === undefined || v === ''))
          throw new InvalidInput(`${field.label} is required`)
      }
      // Only the secrets changed: the same tracker with a new token, nothing to move off it.
      const moves =
        next.plugin !== settings.plugin ||
        JSON.stringify(withoutSecrets(next.options, secret)) !==
          JSON.stringify(withoutSecrets(settings.options, secret))
      if (moves) {
        if ((await store.liveRuns()).length > 0)
          throw new InvalidInput('agents are running: stop them before changing the tracker')
        // A status the tracker lacks holds nothing, and Jira refuses to search for one.
        const ids = flow
          .current()
          .workflow.statuses.map((s) => s.id)
          .filter((id) => !flow.unmatched.includes(id))
        const left = await port.list('item', ids)
        if (left.length > 0)
          throw new InvalidInput(
            `move these off the tracker in use before changing it: ${left.map((i) => i.ref).join(', ')}`,
          )
      }
      let built: TrackerPort
      try {
        built = await build(next)
      } catch (e) {
        throw new InvalidInput(e instanceof Error ? e.message : String(e))
      }
      if (moves) {
        const other = await deps.otherEngine(built)
        if (other !== undefined) throw new InvalidInput(other)
      }
      const saved = await saveInstance(store, 'tracker', actor, expected, {
        plugin: next.plugin,
        options: mapSecrets(next.options, secret, (v) => secrets.seal(v)),
      })
      const before = target
      target = built
      settings = next
      version = saved.version
      if (moves) {
        await clearHeartbeat(before, deps.engineId).catch(() => {})
        instance.rebase(pollDefaultFor(next.plugin))
      }
      flow.unmatched = await unmatchedStatuses(port, flow.current().statuses)
      return saved.version
    },
  }
}
