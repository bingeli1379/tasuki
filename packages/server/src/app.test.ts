import { createStatusMap, type NewItem, type StoragePort, type WorkUnit } from '@tasuki/core'
import { describe, expect, it } from 'vite-plus/test'
import { createApp } from './app'
import { openDatabase } from './runtime-store/database'
import { migrate } from './runtime-store/migrate'

const memoryStorage = (): StoragePort => {
  const units: WorkUnit[] = []
  return {
    list: (kind, status) =>
      Promise.resolve(units.filter((u) => u.kind === kind && u.status === status)),
    createItem: (item: NewItem) => {
      const unit: WorkUnit = { ref: `M-${units.length + 1}`, kind: 'item', labels: [], ...item }
      units.push(unit)
      return Promise.resolve(unit)
    },
  }
}

const appWith = (db = openDatabase(':memory:')): ReturnType<typeof createApp> =>
  createApp({
    db,
    storage: memoryStorage(),
    statuses: createStatusMap({ item: { refining: 'Refining', done: 'Done' } }),
  })

describe('GET /api/health', () => {
  it('reports the schema version of the database it is wired to', async () => {
    const db = openDatabase(':memory:')
    migrate(db, ['CREATE TABLE a (id INTEGER)'])
    const res = await appWith(db).request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, schemaVersion: 1 })
  })
})

describe('items on the board', () => {
  it('a created item shows up in the refining column', async () => {
    const app = appWith()
    const created = await app.request('/api/items', {
      method: 'POST',
      body: JSON.stringify({ title: 'Login page', body: '' }),
    })
    expect(created.status).toBe(201)

    const board = (await (await app.request('/api/board')).json()) as {
      columns: { status: string; displayName: string; items: WorkUnit[] }[]
    }
    expect(
      board.columns.map((c) => [c.status, c.displayName, c.items.map((i) => i.title)]),
    ).toEqual([
      ['refining', 'Refining', ['Login page']],
      ['done', 'Done', []],
    ])
  })

  it('a blank title is a 400 with the reason', async () => {
    const res = await appWith().request('/api/items', {
      method: 'POST',
      body: JSON.stringify({ title: ' ' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'title is required' })
  })
})
