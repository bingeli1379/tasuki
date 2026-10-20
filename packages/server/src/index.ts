import { serve } from '@hono/node-server'
import { join, resolve } from 'node:path'
import { createApp } from './app'
import { openDatabase } from './runtime-store/database'
import { migrate } from './runtime-store/migrate'
import { RUNTIME_MIGRATIONS } from './runtime-store/migrations'

const dataDir = process.env['TASUKI_DATA_DIR'] ?? './data'
const port = Number(process.env['TASUKI_PORT'] ?? 8787)

const dbPath = join(dataDir, 'runtime.db')
const db = openDatabase(dbPath)
migrate(db, RUNTIME_MIGRATIONS)

serve({ fetch: createApp(db).fetch, port, hostname: '127.0.0.1' })
console.log(`runtime store: ${resolve(dbPath)}`)
console.log(`tasuki listening on http://127.0.0.1:${port}`)
