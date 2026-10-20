import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { schemaVersion } from './runtime-store/migrate'

export function createApp(db: DatabaseSync): Hono {
  const app = new Hono()
  app.get('/api/health', (c) => c.json({ ok: true, schemaVersion: schemaVersion(db) }))
  return app
}
