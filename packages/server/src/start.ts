import { serve } from '@hono/node-server'
import {
  clearHeartbeat,
  needsSetup,
  unmatchedStatuses,
  type Clock,
  type TrackerPort,
} from '@tasuki/core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, type AppAuth } from './app'
import { isLoopback, loadConfig } from './config'
import { createLiveAgents, readAgentSettings } from './agent-settings'
import { createApprovals } from './approvals'
import { engineCheck, engineIdOf, printFindings, trackerChecks } from './doctor'
import { createEngine } from './engine'
import { loadFlow } from './flow'
import { loadInstance, pollDefaultFor } from './instance'
import { loadAuth, loadStore, NO_STATUSES } from './plugin-loader'
import { loadSecrets } from './secrets'
import { createLiveTracker, readTrackerSettings } from './tracker-settings'
import { createRunTokens } from './run-tokens'
import { createLoginThrottle, createSetupToken, createSignIns } from './sign-ins'

export interface StartOptions {
  // The built board, served at / when set; in development Vite serves it instead.
  webDir?: string
}

// `tasuki start`: loads everything the config names, refuses on what the file gets wrong, then
// serves and polls until the process is stopped.
export async function startEngine(
  configPath: string | undefined,
  clock: Clock,
  options: StartOptions = {},
): Promise<void> {
  const config = loadConfig(configPath)
  const base = { clock, configDir: config.configDir, dataDir: config.dataDir }
  // The store holds the flow, and the flow says how the tracker keys its statuses, so the
  // store comes first; the mapping it hands plugins follows every save (D91). A store sees
  // none of it.
  const store = await loadStore(config.store.plugin, config.store.options, config.configDir, {
    ...base,
    statuses: NO_STATUSES,
  })
  const secrets = loadSecrets(config.dataDir)
  const saved = await readTrackerSettings(store, secrets, config.configDir)
  const instance = await loadInstance(store, pollDefaultFor(saved.settings.plugin))
  const savedAgents = await readAgentSettings(store, secrets, config.configDir)
  const flow = await loadFlow(store, {
    agents: Object.keys(savedAgents.settings),
    defaultMaxAttempts: instance.current().limits.defaultMaxAttempts,
  })
  const ctx = { ...base, statuses: flow.statuses }
  const engineId = engineIdOf(config.dataDir)
  const otherEngine = async (t: TrackerPort) =>
    (await engineCheck(t, clock, engineId, instance.current().pollSeconds))[0]?.message
  const live = await createLiveTracker(
    { store, flow, instance, secrets, ctx: base, engineId, otherEngine },
    saved,
  )
  const tracker = live.port
  const second = await otherEngine(tracker)
  if (second !== undefined) throw new Error(second)
  flow.unmatched = await unmatchedStatuses(tracker, flow.current().statuses)
  const agents = await createLiveAgents({ store, flow, secrets, ctx }, savedAgents)
  // All of it is put right on the settings pages, so it is only printed (D95): an agent whose
  // CLI is missing fails the Runs that pick it, and the Agents page says why (D108).
  printFindings([
    ...(await trackerChecks(tracker, live.current().plugin, flow)),
    ...(await agents.check()),
  ])
  const tokens = createRunTokens()
  // Allowing a call for good is a save of its agent on the Agents page (D107).
  const approvals = createApprovals(clock, (actor, a) =>
    agents.allow(actor, a.agent, { tool: a.tool, input: a.input }),
  )
  let auth: AppAuth | undefined
  let setupToken: string | undefined
  if (config.auth !== undefined) {
    const port = await loadAuth(config.auth.plugin, config.auth.options, config.configDir, {
      ...ctx,
      store,
    })
    mkdirSync(config.dataDir, { recursive: true })
    const setup = createSetupToken(config.dataDir, await needsSetup(store))
    setupToken = setup.token
    auth = {
      port,
      signIns: createSignIns(store, clock, config.auth),
      throttle: createLoginThrottle(),
      setup,
      ...(config.auth.ttlSeconds === undefined ? {} : { ttlSeconds: config.auth.ttlSeconds }),
    }
  }

  // Agents run on this machine: an engine bound to every address is reached on loopback, one
  // bound to a single address only there.
  const wildcard = config.host === '0.0.0.0' || config.host === '::'
  const agentHost =
    wildcard || isLoopback(config.host)
      ? '127.0.0.1'
      : config.host.includes(':')
        ? `[${config.host}]`
        : config.host
  const listening = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`
  const boardUrl = config.publicUrl ?? (options.webDir === undefined ? undefined : listening)
  serve({
    fetch: createApp({
      tracker,
      trackerSettings: live,
      store,
      flow,
      instance,
      agentSettings: agents,
      approvals,
      tokens,
      ...(auth === undefined ? {} : { auth }),
      ...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
      ...(agentHost === '127.0.0.1' ? {} : { agentHost }),
      ...(options.webDir === undefined ? {} : { webDir: options.webDir }),
    }).fetch,
    port: config.port,
    hostname: config.host,
  })
  const engine = createEngine({
    tracker,
    store,
    clock,
    flow,
    limits: () => instance.current().limits,
    workspaceRoot: join(config.dataDir, 'workspaces'),
    logDir: join(config.dataDir, 'logs'),
    runners: () => agents.runners(),
    tokens,
    approvals,
    mcpUrl: `http://${agentHost}:${config.port}/agent-mcp`,
    engineId,
  })
  // A clean stop frees the project at once instead of three poll rounds later.
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void clearHeartbeat(tracker, engineId)
        .catch((e: unknown) => console.error(`clearing the heartbeat: ${String(e)}`))
        .finally(() => process.exit(0))
    })
  // The first round runs at start, so Runs a crash left behind are recovered right away.
  await engine.tick()
  // Each wait reads the interval again, so a save on the General page needs no restart.
  const poll = (): void => {
    setTimeout(() => void engine.tick().finally(poll), instance.current().pollSeconds * 1000)
  }
  poll()
  // Stop reaches the agent within a second, not a poll interval later.
  setInterval(() => void engine.enforce(), 1000)
  console.log(`data dir: ${config.dataDir}`)
  console.log(`tracker: ${live.current().plugin}`)
  console.log(`store: ${config.store.plugin}`)
  console.log(`auth: ${config.auth?.plugin ?? 'none, nobody signs in'}`)
  if (setupToken !== undefined) {
    console.log(
      `no admin yet: sign in with setup token ${setupToken} (also in ${join(config.dataDir, 'setup-token')})`,
    )
    if (boardUrl !== undefined)
      console.log(`or open ${boardUrl}/?setup=${encodeURIComponent(setupToken)}`)
  }
  console.log(
    `flow: ${flow.saved().version === undefined ? 'the default, never saved' : `version ${flow.saved().version}`}`,
  )
  console.log(
    `rules: ${
      flow
        .current()
        .rules.map((r) => r.id)
        .join(', ') || 'none'
    }`,
  )
  console.log(`tasuki listening on ${listening}`)
  if (config.publicUrl !== undefined) console.log(`public url: ${config.publicUrl}`)
  else if (boardUrl !== undefined) console.log(`board: ${boardUrl}`)
}
