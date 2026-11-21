import { serve } from '@hono/node-server'
import { createStatusMap, itemStatusNames, type Clock, type RunnerPort } from '@tasuki/core'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createApp } from './app'
import { loadConfig } from './config'
import { createEngine } from './engine'
import { loadRunner, loadTracker } from './plugin-loader'
import { createRunTokens } from './run-tokens'
import { openDatabase } from './runtime-store/database'
import { migrate } from './runtime-store/migrate'
import { RUNTIME_MIGRATIONS } from './runtime-store/migrations'
import { createRuntimeStore } from './runtime-store/run-store'

const systemClock: Clock = { now: () => new Date() }

try {
  const { values } = parseArgs({
    options: { config: { type: 'string', default: 'tasuki.config.jsonc' } },
  })
  const config = loadConfig(values.config)
  const statuses = createStatusMap(config.statuses)

  const dbPath = join(config.dataDir, 'runtime.db')
  const db = openDatabase(dbPath)
  migrate(db, RUNTIME_MIGRATIONS)
  const runtime = createRuntimeStore(db, systemClock, join(config.dataDir, 'logs'))
  const ctx = { clock: systemClock, configDir: config.configDir, dataDir: config.dataDir, statuses }
  const storage = await loadTracker(
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
      db,
      storage,
      runtime,
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
    storage,
    runtime,
    clock: systemClock,
    rules: config.rules,
    named: itemStatusNames(config.workflow),
    limits: config.limits,
    holdLabel: config.holdLabel,
    workspaceRoot: join(config.dataDir, 'workspaces'),
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
  console.log(`rules: ${config.rules.map((r) => r.id).join(', ') || 'none'}`)
  console.log(`tasuki listening on http://127.0.0.1:${config.port}`)
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
