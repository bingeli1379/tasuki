import { serve } from '@hono/node-server'
import { createStatusMap, itemStatusNames, type Clock, type RunnerPort } from '@tasuki/core'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createApp } from './app'
import { loadConfig } from './config'
import { createEngine } from './engine'
import { loadRunner, loadStore, loadTracker } from './plugin-loader'
import { createRunTokens } from './run-tokens'

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

  // Loopback only until auth lands (S9, security-and-auth.md).
  serve({
    fetch: createApp({
      tracker,
      store,
      statuses,
      workflow: config.workflow,
      rules: config.rules,
      holdLabel: config.holdLabel,
      tokens,
    }).fetch,
    port: config.port,
    hostname: '127.0.0.1',
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
    mcpUrl: `http://127.0.0.1:${config.port}/agent-mcp`,
  })
  // The first round runs at start, so Runs a crash left behind are recovered right away.
  await engine.tick()
  setInterval(() => void engine.tick(), config.pollSeconds * 1000)
  // Stop reaches the agent within a second, not a poll interval later.
  setInterval(() => void engine.enforce(), 1000)
  console.log(`data dir: ${config.dataDir}`)
  console.log(`tracker: ${config.tracker.plugin}`)
  console.log(`store: ${config.store.plugin}`)
  console.log(`rules: ${config.rules.map((r) => r.id).join(', ') || 'none'}`)
  console.log(`tasuki listening on http://127.0.0.1:${config.port}`)
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
