import { serve } from '@hono/node-server'
import {
  clearHeartbeat,
  needsSetup,
  unmatchedStatuses,
  type Clock,
  type RunnerPort,
} from '@tasuki/core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, type AppAuth } from './app'
import { isLoopback, loadConfig } from './config'
import { agentChecks, engineCheck, engineIdOf, printFindings, trackerChecks } from './doctor'
import { createEngine } from './engine'
import { loadFlow } from './flow'
import { loadAuth, loadRunner, loadStore, loadTracker, NO_STATUSES } from './plugin-loader'
import { createRunTokens } from './run-tokens'
import { createLoginThrottle, createSetupToken, createSignIns } from './sign-ins'

export interface StartOptions {
  // The built board, served at / when set; in development Vite serves it instead.
  webDir?: string
}

// `tasuki start`: loads everything the config names, refuses on what the file gets wrong, then
// serves and polls until the process is stopped.
export async function startEngine(
  configPath: string,
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
  const flow = await loadFlow(store, {
    agents: Object.keys(config.agents),
    defaultMaxAttempts: config.limits.defaultMaxAttempts,
  })
  const ctx = { ...base, statuses: flow.statuses }
  const tracker = await loadTracker(
    config.tracker.plugin,
    config.tracker.options,
    config.configDir,
    ctx,
  )
  const engineId = engineIdOf(config.dataDir)
  const second = await engineCheck(tracker, clock, engineId, config.pollSeconds)
  if (second[0] !== undefined) throw new Error(second[0].message)
  flow.unmatched = await unmatchedStatuses(tracker, flow.current().statuses)
  const runners: Record<string, RunnerPort> = {}
  for (const [name, agent] of Object.entries(config.agents))
    runners[name] = await loadRunner(agent.plugin, agent.options, config.configDir, ctx)
  // What the file sets has to work before anything runs; what the flow asks of the tracker
  // is put right on the settings page, so it is only printed (D95).
  const agentFindings = await agentChecks(runners)
  printFindings([...(await trackerChecks(tracker, config.tracker.plugin, flow)), ...agentFindings])
  if (agentFindings.some((f) => f.level === 'error'))
    throw new Error('an agent cannot run: see the errors above, or run doctor')
  const tokens = createRunTokens()
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
      store,
      flow,
      agents: Object.keys(config.agents),
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
    limits: config.limits,
    workspaceRoot: join(config.dataDir, 'workspaces'),
    logDir: join(config.dataDir, 'logs'),
    runners,
    tokens,
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
  setInterval(() => void engine.tick(), config.pollSeconds * 1000)
  // Stop reaches the agent within a second, not a poll interval later.
  setInterval(() => void engine.enforce(), 1000)
  console.log(`data dir: ${config.dataDir}`)
  console.log(`tracker: ${config.tracker.plugin}`)
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
