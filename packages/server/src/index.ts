import { serve } from '@hono/node-server'
import {
  createStatusMap,
  itemStatusNames,
  needsSetup,
  type Clock,
  type RunnerPort,
} from '@tasuki/core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createApp, type AppAuth } from './app'
import { isLoopback, loadConfig } from './config'
import { createEngine } from './engine'
import { loadAuth, loadRunner, loadStore, loadTracker } from './plugin-loader'
import { createRunTokens } from './run-tokens'
import { createLoginThrottle, createSetupToken, createSignIns } from './sign-ins'

const systemClock: Clock = { now: () => new Date() }

try {
  const { values } = parseArgs({
    options: { config: { type: 'string', default: 'tasuki.config.jsonc' } },
  })
  const config = loadConfig(values.config)
  const statuses = createStatusMap(config.statuses)

  const ctx = { clock: systemClock, configDir: config.configDir, dataDir: config.dataDir, statuses }
  const store = await loadStore(config.store.plugin, config.store.options, config.configDir, ctx)
  const tracker = await loadTracker(
    config.tracker.plugin,
    config.tracker.options,
    config.configDir,
    ctx,
  )
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
      statuses,
      workflow: config.workflow,
      rules: config.rules,
      holdLabel: config.holdLabel,
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
    rules: config.rules,
    named: itemStatusNames(config.workflow),
    limits: config.limits,
    holdLabel: config.holdLabel,
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
  console.log(`rules: ${config.rules.map((r) => r.id).join(', ') || 'none'}`)
  console.log(`tasuki listening on ${listening}`)
  if (config.publicUrl !== undefined) console.log(`public url: ${config.publicUrl}`)
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
