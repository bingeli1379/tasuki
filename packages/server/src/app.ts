import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  addAttachment,
  addComment,
  createItem,
  EditConflict,
  getItem,
  InvalidInput,
  listBoard,
  MAX_ATTACHMENT_BYTES,
  moveItem,
  NotFound,
  StatusConflict,
  updateItem,
  type Rule,
  type RuntimeStorePort,
  type StatusMap,
  type StoragePort,
} from '@tasuki/core'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { DatabaseSync } from 'node:sqlite'
import { createAgentMcpServer } from './agent-mcp'
import { createMcpServer } from './mcp'
import type { RunTokens } from './run-tokens'
import { schemaVersion } from './runtime-store/migrate'

// encodeURIComponent leaves ' ( ) * alone, which RFC 5987 does not allow unencoded.
const encodeRfc5987 = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface AppDeps {
  db: DatabaseSync
  storage: StoragePort
  runtime: RuntimeStorePort
  statuses: StatusMap
  rules: readonly Rule[]
  tokens: RunTokens
}

export function createApp({ db, storage, runtime, statuses, rules, tokens }: AppDeps): Hono {
  const app = new Hono()
  app.onError((e, c) => {
    if (e instanceof InvalidInput) return c.json({ error: e.message }, 400)
    if (e instanceof NotFound) return c.json({ error: e.message }, 404)
    // The board puts the card where it really is.
    if (e instanceof StatusConflict || e instanceof EditConflict)
      return c.json({ error: e.message, item: e.current }, 409)
    return c.json({ error: e.message }, 500)
  })
  app.get('/api/health', (c) => c.json({ ok: true, schemaVersion: schemaVersion(db) }))
  app.get('/api/board', async (c) =>
    c.json(
      await listBoard(
        storage,
        runtime,
        { item: statuses.mapped('item'), task: statuses.mapped('task') },
        rules,
      ),
    ),
  )
  app.post('/api/items', async (c) => {
    const body = await c.req.json<{ title?: unknown; body?: unknown }>()
    const item = await createItem(storage, {
      title: typeof body.title === 'string' ? body.title : '',
      body: typeof body.body === 'string' ? body.body : '',
    })
    return c.json(item, 201)
  })
  app.post('/api/items/:ref/transition', async (c) => {
    const body = await c.req.json<{ from?: unknown; to?: unknown }>()
    if (typeof body.from !== 'string' || typeof body.to !== 'string')
      throw new InvalidInput('from and to are required')
    return c.json(
      await moveItem(storage, statuses.mapped('item'), {
        ref: c.req.param('ref'),
        from: body.from,
        to: body.to,
      }),
    )
  })
  app.get('/api/items/:ref', async (c) =>
    c.json(await getItem(storage, runtime, c.req.param('ref'))),
  )
  app.patch('/api/items/:ref', async (c) => {
    const body = await c.req.json<{ expectedVersion?: unknown; title?: unknown; body?: unknown }>()
    if (typeof body.expectedVersion !== 'string')
      throw new InvalidInput('expectedVersion is required')
    return c.json(
      await updateItem(storage, {
        ref: c.req.param('ref'),
        expectedVersion: body.expectedVersion,
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.body === 'string' ? { body: body.body } : {}),
      }),
    )
  })
  app.post('/api/items/:ref/comments', async (c) => {
    const body = await c.req.json<{ body?: unknown }>()
    const comment = await addComment(storage, {
      ref: c.req.param('ref'),
      body: typeof body.body === 'string' ? body.body : '',
    })
    return c.json(comment, 201)
  })
  app.post(
    '/api/items/:ref/attachments',
    // Room for the multipart envelope around a file at the limit.
    bodyLimit({
      maxSize: MAX_ATTACHMENT_BYTES + 64 * 1024,
      onError: (c) => c.json({ error: 'file is larger than 10 MB' }, 413),
    }),
    async (c) => {
      const file = (await c.req.parseBody())['file']
      if (!(file instanceof File)) throw new InvalidInput('send the file as multipart field "file"')
      const attachment = await addAttachment(storage, c.req.param('ref'), {
        filename: file.name,
        mimeType: file.type,
        data: new Uint8Array(await file.arrayBuffer()),
      })
      return c.json(attachment, 201)
    },
  )
  app.get('/api/items/:ref/attachments/:id', async (c) => {
    const { attachment, data } = await storage.readAttachment(c.req.param('ref'), c.req.param('id'))
    // Attachments are anyone's upload, so only raster images display in the page. Anything
    // else, SVG included (it can carry script), downloads as an opaque file.
    const inline = INLINE_IMAGES.has(attachment.mimeType)
    return c.body(data as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': inline ? attachment.mimeType : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeRfc5987(attachment.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    })
  })
  // Stateless (no sessionIdGenerator): a fresh server and transport per request, as the SDK
  // recommends for that mode.
  app.all('/mcp', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await createMcpServer({ storage, runtime, statuses, rules }).connect(transport)
    return transport.handleRequest(c.req.raw)
  })
  // The facade for agents the engine started: only a live Run's token gets in.
  app.all('/agent-mcp', async (c) => {
    const token = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1]
    const runId = token === undefined ? undefined : tokens.resolve(token)
    const run = runId === undefined ? undefined : await runtime.getRun(runId)
    const mode = rules.find((r) => r.id === run?.rule)?.mode
    if (run?.state !== 'running' || mode === undefined)
      return c.json({ error: 'not a live run token' }, 401)
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await createAgentMcpServer({ storage, runtime, run, mode }).connect(transport)
    return transport.handleRequest(c.req.raw)
  })
  return app
}
