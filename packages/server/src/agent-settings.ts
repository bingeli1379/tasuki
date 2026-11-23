import {
  assertEditsInstance,
  InvalidInput,
  saveInstance,
  type Account,
  type OptionField,
  type OptionsForm,
  type PluginContext,
  type RunnerPort,
  type StorePort,
} from '@tasuki/core'
import { agentChecks, type Finding } from './doctor'
import type { LiveFlow } from './flow'
import {
  checkRequired,
  getPath,
  isObject,
  keepSecrets,
  mapSecrets,
  secretKeys,
  withoutSecrets,
  type Raw,
} from './options-form'
import { loadRunner, loadRunnerForm } from './plugin-loader'
import type { Secrets } from './secrets'

// One agent: a runner plugin and its options, picked by name from a rule. Kept in the store
// and edited by an admin on the Agents page (D105, D107). Secrets are in the clear here; only
// the store sees them sealed.
export interface AgentSettings {
  plugin: string
  options: Raw
}

export type AgentsSettings = Record<string, AgentSettings>

// What a store never saved to runs on (D110). Both CLIs with this machine's login; the claude
// one may read and edit files and run git and node, and is asked before anything else.
export const DEFAULT_AGENTS: AgentsSettings = {
  claude: {
    plugin: '@tasuki/claude-cli',
    options: {
      permissions: 'allowlist',
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git:*)', 'Bash(node:*)'],
    },
  },
  codex: { plugin: '@tasuki/codex-cli', options: { permissions: 'allowlist' } },
}

// A rule names its agent by this, so it never changes once made.
const NAME = /^[a-z0-9][a-z0-9-]*$/

export interface AgentView {
  name: string
  plugin: string
  options: Raw
  secretsSet: string[]
  fields: OptionField[]
}

export interface LiveAgents {
  // Read at each Run's start, so a save applies from the next Run; one going keeps its own.
  runners(): Readonly<Record<string, RunnerPort>>
  current(): AgentsSettings
  view(): Promise<{ version?: number; agents: AgentView[] }>
  // The form of any runner plugin, for adding an agent on it.
  form(plugin: string): Promise<{ fields: OptionField[] }>
  // Each agent's own preflight: the CLI is there, signed in, has what it needs (D108).
  check(): Promise<Finding[]>
  save(actor: Account, expected: number | undefined, raw: unknown): Promise<number>
}

export interface AgentsDeps {
  store: StorePort
  flow: LiveFlow
  secrets: Secrets
  ctx: PluginContext
}

async function formOf(plugin: string, configDir: string): Promise<OptionsForm | undefined> {
  try {
    return await loadRunnerForm(plugin, configDir)
  } catch (e) {
    throw new InvalidInput(e instanceof Error ? e.message : String(e))
  }
}

// The agents as last saved, their secrets opened, or the defaults.
export async function readAgentSettings(
  store: StorePort,
  secrets: Secrets,
  configDir: string,
): Promise<{ settings: AgentsSettings; version?: number }> {
  const latest = await store.latestSettings('agents')
  if (latest === undefined) return { settings: DEFAULT_AGENTS }
  const saved = latest.value as AgentsSettings
  const settings: AgentsSettings = {}
  for (const [name, agent] of Object.entries(saved)) {
    const form = await loadRunnerForm(agent.plugin, configDir)
    settings[name] = {
      plugin: agent.plugin,
      options: mapSecrets(agent.options, secretKeys(form), (v) => secrets.open(v)),
    }
  }
  return { settings, version: latest.version }
}

async function buildAll(
  settings: AgentsSettings,
  ctx: PluginContext,
): Promise<Record<string, RunnerPort>> {
  const runners: Record<string, RunnerPort> = {}
  for (const [name, agent] of Object.entries(settings)) {
    try {
      runners[name] = await loadRunner(agent.plugin, agent.options, ctx.configDir, ctx)
    } catch (e) {
      throw new InvalidInput(`agent ${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return runners
}

export async function createLiveAgents(
  deps: AgentsDeps,
  initial: { settings: AgentsSettings; version?: number },
): Promise<LiveAgents> {
  const { store, flow, secrets, ctx } = deps
  let settings = initial.settings
  let version = initial.version
  let runners = await buildAll(settings, ctx)
  return {
    runners: () => runners,
    current: () => settings,
    async view() {
      const agents: AgentView[] = []
      for (const [name, agent] of Object.entries(settings)) {
        const form = await loadRunnerForm(agent.plugin, ctx.configDir)
        const secret = secretKeys(form)
        agents.push({
          name,
          plugin: agent.plugin,
          options: withoutSecrets(agent.options, secret),
          secretsSet: secret.filter((k) => getPath(agent.options, k) !== undefined),
          fields: form?.fields ?? [],
        })
      }
      return { ...(version === undefined ? {} : { version }), agents }
    },
    async form(plugin) {
      return { fields: (await formOf(plugin, ctx.configDir))?.fields ?? [] }
    },
    check: () => agentChecks(runners),
    async save(actor, expected, raw) {
      assertEditsInstance(actor)
      if (!isObject(raw)) throw new InvalidInput('agents must map names to agents')
      const next: AgentsSettings = {}
      const sealed: AgentsSettings = {}
      for (const [name, agent] of Object.entries(raw)) {
        if (!NAME.test(name))
          throw new InvalidInput(
            `agent name ${name}: lowercase letters, digits and dashes, starting with a letter or digit`,
          )
        if (!isObject(agent) || typeof agent['plugin'] !== 'string' || agent['plugin'] === '')
          throw new InvalidInput(`agent ${name}: plugin must be a package name`)
        const plugin = agent['plugin']
        const options = agent['options'] ?? {}
        if (!isObject(options)) throw new InvalidInput(`agent ${name}: options must be an object`)
        const form = await formOf(plugin, ctx.configDir)
        const secret = secretKeys(form)
        const before = settings[name]
        const filled = keepSecrets(
          options,
          secret,
          before?.plugin === plugin ? before.options : undefined,
        )
        const missing = checkRequired(filled, form)
        if (missing !== undefined) throw new InvalidInput(`agent ${name}: ${missing}`)
        next[name] = { plugin, options: filled }
        sealed[name] = { plugin, options: mapSecrets(filled, secret, (v) => secrets.seal(v)) }
      }
      const names = Object.keys(next)
      const orphaned = flow.current().rules.filter((r) => !names.includes(r.agent))
      if (orphaned.length > 0)
        throw new InvalidInput(
          `rules still use these agents; point them elsewhere on the Workflow page first: ${orphaned
            .map((r) => `${r.id} (${r.agent})`)
            .join(', ')}`,
        )
      const built = await buildAll(next, ctx)
      const saved = await saveInstance(store, 'agents', actor, expected, sealed)
      runners = built
      settings = next
      version = saved.version
      flow.rebase({ ...flow.context, agents: names })
      return saved.version
    },
  }
}
