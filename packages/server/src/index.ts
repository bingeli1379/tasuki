import { serve } from '@hono/node-server'
import { needsSetup, unmatchedStatuses, type Clock, type RunnerPort } from '@tasuki/core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createApp, type AppAuth } from './app'
import { isLoopback, loadConfig } from './config'
import { createEngine } from './engine'
import { loadFlow } from './flow'
import { loadAuth, loadRunner, loadStore, loadTracker } from './plugin-loader'
import { createRunTokens } from './run-tokens'
import { createLoginThrottle, createSetupToken, createSignIns } from './sign-ins'

const systemClock: Clock = { now: () => new Date() }

try {
  const { values } = parseArgs({
    options: { config: { type: 'string', default: 'tasuki.config.jsonc' } },
  })
  const config = loadConfig(values.config)
  const base = { clock: systemClock, configDir: config.configDir, dataDir: config.dataDir }
  // The store holds the flow, and the flow says how the tracker keys its statuses, so the
  // store comes first; the mapping it hands plugins follows every save (D91). A store sees
  // none of it.
  const store = await loadStore(config.store.plugin, config.store.options, config.configDir, {
    ...base,
    statuses: {
      toTracker: () => {
        throw new Error('a store has no status mapping')
      },
      fromTracker: () => undefined,
      mapped: () => [],
    },
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
  flow.unmatched = await unmatchedStatuses(tracker, flow.current().statuses)
  const runners: Record<string, RunnerPort> = {}
  for (const [name, agent] of Object.entries(config.agents))
    runners[name] = await loadRunner(agent.plugin, agent.options, config.configDir, ctx)
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
      signIns: createSignIns(store, systemClock, config.auth),
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
    }).fetch,
    port: config.port,
    hostname: config.host,
  })
  const engine = createEngine({
    tracker,
    store,
    clock: systemClock,
    flow,
    limits: config.limits,
    workspaceRoot: join(config.dataDir, 'workspaces'),
    logDir: join(config.dataDir, 'logs'),
    runners,
    tokens,
    mcpUrl: `http://${agentHost}:${config.port}/agent-mcp`,
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
    // The board is served apart from the engine until S12, so only publicUrl says where it is.
    if (config.publicUrl !== undefined)
      console.log(`or open ${config.publicUrl}/?setup=${encodeURIComponent(setupToken)}`)
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
  if (flow.unmatched.length > 0)
    console.log(
      `not a status in the tracker: ${flow.unmatched.join(', ')}; no agent starts until the settings page maps them`,
    )
  console.log(`tasuki listening on ${listening}`)
  if (config.publicUrl !== undefined) console.log(`public url: ${config.publicUrl}`)
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
