import { serve } from '@hono/node-server'
import { createStatusMap, type Clock } from '@tasuki/core'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createApp } from './app'
import { loadConfig } from './config'
import { loadTracker } from './plugin-loader'
import { openDatabase } from './runtime-store/database'
import { migrate } from './runtime-store/migrate'
import { RUNTIME_MIGRATIONS } from './runtime-store/migrations'

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
  const storage = await loadTracker(
    config.tracker.plugin,
    config.tracker.options,
    config.configDir,
    {
      clock: systemClock,
      dataDir: config.dataDir,
      statuses,
    },
  )

  // Loopback only until auth lands (S9, security-and-auth.md).
  serve({
    fetch: createApp({ db, storage, statuses }).fetch,
    port: config.port,
    hostname: '127.0.0.1',
  })
  console.log(`data dir: ${config.dataDir}`)
  console.log(`tracker: ${config.tracker.plugin}`)
  console.log(`tasuki listening on http://127.0.0.1:${config.port}`)
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
