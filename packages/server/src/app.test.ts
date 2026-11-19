import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createStatusMap,
  NotFound,
  StatusConflict,
  type NewItem,
  type StoragePort,
  type WorkUnit,
} from '@tasuki/core'
import { describe, expect, it } from 'vite-plus/test'
import { createApp } from './app'
import { openDatabase } from './runtime-store/database'
import { migrate } from './runtime-store/migrate'

const memoryStorage = (): StoragePort => {
  const units: WorkUnit[] = []
  const find = (ref: string): WorkUnit => {
    const unit = units.find((u) => u.ref === ref)
    if (unit === undefined) throw new NotFound(`${ref} does not exist`)
    return unit
  }
  return {
    list: (kind, status) =>
      Promise.resolve(units.filter((u) => u.kind === kind && u.status === status)),
    get: async (ref) => ({ ...find(ref) }),
    transition: async (ref, from, to) => {
      const unit = find(ref)
      if (unit.status !== from) throw new StatusConflict(from, { ...unit })
      unit.status = to
      return { ...unit }
    },
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
    statuses: createStatusMap({
      item: { refining: 'Refining', 'ready-to-split': 'Ready to Split', done: 'Done' },
    }),
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
      ['ready-to-split', 'Ready to Split', []],
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

describe('moving an item', () => {
  const post = (
    app: ReturnType<typeof createApp>,
    path: string,
    body: unknown,
  ): Promise<Response> | Response =>
    app.request(path, { method: 'POST', body: JSON.stringify(body) })
  const created = async (app: ReturnType<typeof createApp>): Promise<WorkUnit> =>
    (await (await post(app, '/api/items', { title: 'Login page', body: '' })).json()) as WorkUnit

  it('moves the item and the board shows it in the new column', async () => {
    const app = appWith()
    const item = await created(app)
    const res = await post(app, `/api/items/${item.ref}/transition`, {
      from: 'refining',
      to: 'done',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ref: item.ref, status: 'done' })

    const board = (await (await app.request('/api/board')).json()) as {
      columns: { status: string; items: WorkUnit[] }[]
    }
    expect(board.columns.map((c) => [c.status, c.items.length])).toEqual([
      ['refining', 0],
      ['ready-to-split', 0],
      ['done', 1],
    ])
  })

  it('a move from a status the item already left is a 409 with where it is now', async () => {
    const app = appWith()
    const item = await created(app)
    await post(app, `/api/items/${item.ref}/transition`, { from: 'refining', to: 'done' })

    const res = await post(app, `/api/items/${item.ref}/transition`, {
      from: 'refining',
      to: 'ready-to-split',
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      error: `${item.ref} is in done, not refining`,
      item: { ref: item.ref, status: 'done' },
    })
  })

  it('an unknown ref is a 404', async () => {
    const res = await post(appWith(), '/api/items/M-9/transition', { from: 'refining', to: 'done' })
    expect(res.status).toBe(404)
  })

  it('a status that is not a column is a 400', async () => {
    const app = appWith()
    const item = await created(app)
    const res = await post(app, `/api/items/${item.ref}/transition`, {
      from: 'refining',
      to: 'blocked',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'status "blocked" is not on the board' })
  })
})

describe("MCP for the user's AI client", () => {
  const connect = async (): Promise<Client> => {
    const app = appWith()
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: (url, init) => Promise.resolve(app.request(String(url), init)),
      }),
    )
    return client
  }
  const text = (result: Awaited<ReturnType<Client['callTool']>>): string =>
    (result.content as { type: string; text: string }[])[0]?.text ?? ''

  it('lists the tools', async () => {
    const { tools } = await (await connect()).listTools()
    expect(tools.map((t) => t.name)).toEqual(['list_board', 'create_item', 'move_item'])
  })

  it('an item created through MCP is on the board', async () => {
    const client = await connect()
    const created = await client.callTool({
      name: 'create_item',
      arguments: { title: 'From Claude', body: 'two\nlines' },
    })
    expect(JSON.parse(text(created))).toMatchObject({ title: 'From Claude', status: 'refining' })

    const board = JSON.parse(
      text(await client.callTool({ name: 'list_board', arguments: {} })),
    ) as {
      columns: { status: string; items: { title: string }[] }[]
    }
    expect(board.columns[0]).toMatchObject({
      status: 'refining',
      items: [{ title: 'From Claude' }],
    })
  })

  it('a blank title comes back as a tool error with the reason', async () => {
    const result = await (
      await connect()
    ).callTool({
      name: 'create_item',
      arguments: { title: ' ' },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('title is required')
  })

  it('moves an item, and a stale move says where the item is now', async () => {
    const client = await connect()
    const item = JSON.parse(
      text(await client.callTool({ name: 'create_item', arguments: { title: 'From Claude' } })),
    ) as WorkUnit
    const moved = await client.callTool({
      name: 'move_item',
      arguments: { ref: item.ref, from: 'refining', to: 'ready-to-split' },
    })
    expect(JSON.parse(text(moved))).toMatchObject({ ref: item.ref, status: 'ready-to-split' })

    const stale = await client.callTool({
      name: 'move_item',
      arguments: { ref: item.ref, from: 'refining', to: 'done' },
    })
    expect(stale.isError).toBe(true)
    expect(text(stale)).toContain(`${item.ref} is in ready-to-split, not refining`)
  })
})
