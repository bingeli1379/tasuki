import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createItem, InvalidInput, listBoard, type StatusMap, type StoragePort } from '@tasuki/core'
import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { createMcpServer } from './mcp'
import { schemaVersion } from './runtime-store/migrate'

export interface AppDeps {
  db: DatabaseSync
  storage: StoragePort
  statuses: StatusMap
}

export function createApp({ db, storage, statuses }: AppDeps): Hono {
  const app = new Hono()
  app.onError((e, c) =>
    e instanceof InvalidInput
      ? c.json({ error: e.message }, 400)
      : c.json({ error: e.message }, 500),
  )
  app.get('/api/health', (c) => c.json({ ok: true, schemaVersion: schemaVersion(db) }))
  app.get('/api/board', async (c) =>
    c.json({ columns: await listBoard(storage, statuses.mapped('item')) }),
  )
  app.post('/api/items', async (c) => {
    const body = await c.req.json<{ title?: unknown; body?: unknown }>()
    const item = await createItem(storage, {
      title: typeof body.title === 'string' ? body.title : '',
      body: typeof body.body === 'string' ? body.body : '',
    })
    return c.json(item, 201)
  })
  // Stateless (no sessionIdGenerator): a fresh server and transport per request, as the SDK
  // recommends for that mode.
  app.all('/mcp', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await createMcpServer({ storage, statuses }).connect(transport)
    return transport.handleRequest(c.req.raw)
  })
  return app
}
