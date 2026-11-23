import {
  otherEngine,
  ruleTransitions,
  unmatchedStatuses,
  withSharedStatuses,
  type Clock,
  type DoctorFinding,
  type RunnerPort,
  type TrackerPort,
} from '@tasuki/core'
import { hostname } from 'node:os'
import { styleText } from 'node:util'
import { loadConfig } from './config'
import { loadFlow, type LiveFlow } from './flow'
import { loadInstance, pollDefaultFor, type LiveInstance } from './instance'
import { loadSecrets } from './secrets'
import { readTrackerSettings, type TrackerSettings } from './tracker-settings'
import { loadAuth, loadRunner, loadStore, loadTracker, NO_STATUSES } from './plugin-loader'

export interface Finding extends DoctorFinding {
  // Who it is about: "tracker @tasuki/jira-cloud", "agent claude-main", "engine".
  where: string
}

// The same across restarts on this machine, so the heartbeat a crash left is its own (D66).
export const engineIdOf = (dataDir: string): string => `${hostname()}:${dataDir}`

// Another engine is live while its heartbeat is newer than three poll rounds.
export const freshSeconds = (pollSeconds: number): number => 3 * pollSeconds

async function asked(where: string, check: () => Promise<DoctorFinding[]>): Promise<Finding[]> {
  try {
    return (await check()).map((f) => ({ ...f, where }))
  } catch (e) {
    return [{ level: 'error', where, message: e instanceof Error ? e.message : String(e) }]
  }
}

// The flow against the tracker: statuses it lacks and moves its workflow does not allow
// (config-and-rules.md, check 8). The settings page is where the flow is put right, so the
// start only prints these (D95).
export async function trackerChecks(
  tracker: TrackerPort,
  trackerPlugin: string,
  flow: LiveFlow,
): Promise<Finding[]> {
  const where = `tracker ${trackerPlugin}`
  const unmatched = await asked(where, async () => {
    const statuses = await unmatchedStatuses(tracker, flow.current().statuses)
    return statuses.map((s) => ({
      level: 'warning' as const,
      message: `not a status in the tracker: ${s}; no agent starts until the settings page maps it`,
    }))
  })
  if (tracker.doctor === undefined) return unmatched
  const transitions = ruleTransitions(flow.current().rules)
  return [
    ...unmatched,
    ...(await asked(where, async () => (await tracker.doctor?.(transitions)) ?? [])),
  ]
}

// The agent preflight (checks 9 and 10), one runner after another: a CLI probe may take a
// while, and they print in config order.
export async function agentChecks(
  runners: Readonly<Record<string, RunnerPort>>,
): Promise<Finding[]> {
  const found: Finding[] = []
  for (const [name, runner] of Object.entries(runners)) {
    if (runner.doctor !== undefined)
      found.push(...(await asked(`agent ${name}`, async () => (await runner.doctor?.()) ?? [])))
  }
  return found
}

export async function engineCheck(
  tracker: TrackerPort,
  clock: Clock,
  engineId: string,
  pollSeconds: number,
): Promise<Finding[]> {
  return asked('engine', async () => {
    const other = await otherEngine(tracker, clock, engineId, freshSeconds(pollSeconds))
    if (other === undefined) return []
    const ago = Math.round((clock.now().getTime() - Date.parse(other.lastSeen)) / 1000)
    return [
      {
        level: 'error',
        message: `another engine runs the rules on this project: ${other.engineId}, seen ${ago}s ago. Stop it first; one project takes one engine (D66)`,
      },
    ]
  })
}

export function printFindings(findings: readonly Finding[]): void {
  for (const f of findings)
    console.log(
      `${styleText(f.level === 'error' ? ['red', 'bold'] : 'yellow', `${f.level}:`)} ${styleText('dim', `${f.where}:`)} ${f.message}`,
    )
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// `doctor`: every check the start runs, and what loading refuses, listed in full rather than
// stopping at the first. Returns the exit code: 1 when anything is an error.
export async function runDoctor(configPath: string | undefined, clock: Clock): Promise<number> {
  const findings: Finding[] = []
  const fail = (where: string, e: unknown): void => {
    findings.push({ level: 'error', where, message: messageOf(e) })
  }
  const report = (): number => {
    printFindings(findings)
    const errors = findings.filter((f) => f.level === 'error').length
    const summary = `doctor: ${errors} errors, ${findings.length - errors} warnings`
    console.log(styleText(errors > 0 ? 'red' : 'green', summary))
    return errors > 0 ? 1 : 0
  }
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig(configPath)
  } catch (e) {
    fail('config', e)
    return report()
  }
  const base = { clock, configDir: config.configDir, dataDir: config.dataDir }
  // The store holds the flow, and the rules in it are what the rest is checked against.
  let flow: LiveFlow
  let instance: LiveInstance
  let tracker: TrackerSettings
  let store: Awaited<ReturnType<typeof loadStore>>
  try {
    store = await loadStore(config.store.plugin, config.store.options, config.configDir, {
      ...base,
      statuses: NO_STATUSES,
    })
  } catch (e) {
    fail(`store ${config.store.plugin}`, e)
    return report()
  }
  try {
    tracker = (await readTrackerSettings(store, loadSecrets(config.dataDir), config.configDir))
      .settings
    instance = await loadInstance(store, pollDefaultFor(tracker.plugin))
    flow = await loadFlow(store, {
      agents: Object.keys(config.agents),
      defaultMaxAttempts: instance.current().limits.defaultMaxAttempts,
    })
  } catch (e) {
    fail('settings', e)
    return report()
  }
  const ctx = { ...base, statuses: flow.statuses }
  try {
    const port = withSharedStatuses(
      await loadTracker(tracker.plugin, tracker.options, config.configDir, ctx),
      store,
      flow.statuses,
    )
    findings.push(
      ...(await engineCheck(
        port,
        clock,
        engineIdOf(config.dataDir),
        instance.current().pollSeconds,
      )),
      ...(await trackerChecks(port, tracker.plugin, flow)),
    )
  } catch (e) {
    fail(`tracker ${tracker.plugin}`, e)
  }
  const runners: Record<string, RunnerPort> = {}
  for (const [name, agent] of Object.entries(config.agents)) {
    try {
      runners[name] = await loadRunner(agent.plugin, agent.options, config.configDir, ctx)
    } catch (e) {
      fail(`agent ${name}`, e)
    }
  }
  findings.push(...(await agentChecks(runners)))
  if (config.auth !== undefined) {
    try {
      await loadAuth(config.auth.plugin, config.auth.options, config.configDir, { ...ctx, store })
    } catch (e) {
      fail(`auth ${config.auth.plugin}`, e)
    }
  }
  return report()
}
