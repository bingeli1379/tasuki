import { describe, expect, it } from 'vite-plus/test'
import { createApp } from './app'
import { openDatabase } from './runtime-store/database'
import { migrate } from './runtime-store/migrate'

describe('GET /api/health', () => {
  it('reports the schema version of the database it is wired to', async () => {
    const db = openDatabase(':memory:')
    migrate(db, ['CREATE TABLE a (id INTEGER)'])
    const res = await createApp(db).request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, schemaVersion: 1 })
  })
})
