import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createBuiltinAuth } from '@tasuki/auth-builtin'
import { createStatusMap, type Comment, type StorePort, type Workflow } from '@tasuki/core'
import {
  createSqliteStore,
  createSqliteTracker,
  migrate,
  openDatabase,
  STORE_MIGRATIONS,
  TRACKER_MIGRATIONS,
} from '@tasuki/sqlite'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vite-plus/test'
import { createApp } from './app'
import { createRunTokens } from './run-tokens'
import { createLoginThrottle, createSetupToken, createSignIns } from './sign-ins'

const statuses = createStatusMap({ item: { refining: 'Refining', done: 'Done' } })
const workflow: Workflow = {
  statuses: [
    { id: 'refining', name: 'Refining', outcomes: [] },
    { id: 'done', name: 'Done', outcomes: [] },
  ],
  roles: { entry: 'refining', failure: 'done' },
}

let now: number
const clock = { now: () => new Date(now) }
let slept: number[]

function engine(
  ttl = { ttl: '7d', ttlSeconds: 7 * 86400 },
  shared?: { store: StorePort; dir: string },
) {
  const trackerDb = openDatabase(':memory:')
  migrate(trackerDb, TRACKER_MIGRATIONS)
  const tracker = createSqliteTracker(
    { clock, configDir: '', dataDir: '', statuses },
    trackerDb,
    'M',
  )
  let store = shared?.store
  if (store === undefined) {
    const db = openDatabase(':memory:')
    migrate(db, STORE_MIGRATIONS)
    store = createSqliteStore(db, clock)
  }
  const dir = shared?.dir ?? mkdtempSync(join(tmpdir(), 'tasuki-auth-'))
  const setup = createSetupToken(dir, shared === undefined)
  const app = createApp({
    tracker,
    store,
    statuses,
    workflow,
    rules: [],
    holdLabel: 'hold',
    tokens: createRunTokens(),
    auth: {
      port: createBuiltinAuth(store),
      signIns: createSignIns(store, clock, ttl),
      throttle: createLoginThrottle(async (ms) => void slept.push(ms)),
      setup,
      ttlSeconds: ttl.ttlSeconds,
    },
  })
  return { app, store, dir, setupToken: setup.token ?? '' }
}

type App = ReturnType<typeof engine>['app']
const json = (method: string, body: unknown, cookie?: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
})
const cookieOf = (res: Response): string =>
  (res.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''

async function firstAdmin(e: ReturnType<typeof engine>): Promise<string> {
  const res = await e.app.request(
    '/api/auth/setup',
    json('POST', {
      token: e.setupToken,
      username: 'eli',
      password: 'admin pass',
    }),
  )
  expect(res.status).toBe(200)
  return cookieOf(res)
}

async function login(app: App, username: string, password: string): Promise<Response> {
  return app.request('/api/auth/login', json('POST', { username, password }))
}

beforeEach(() => {
  now = Date.parse('2026-11-22T00:00:00Z')
  slept = []
})

describe('the first admin', () => {
  it('comes from the setup token, which is in dataDir until it is used', async () => {
    const e = engine()
    expect(readFileSync(join(e.dir, 'setup-token'), 'utf8').trim()).toBe(e.setupToken)
    expect(await (await e.app.request('/api/auth/state')).json()).toEqual({
      mode: 'builtin',
      needsSetup: true,
    })
    const wrong = await e.app.request(
      '/api/auth/setup',
      json('POST', { token: 'guess', username: 'x', password: 'long enough' }),
    )
    expect(wrong.status).toBe(401)

    const cookie = await firstAdmin(e)
    const state = await (
      await e.app.request('/api/auth/state', { headers: { Cookie: cookie } })
    ).json()
    expect(state).toMatchObject({ needsSetup: false, me: { username: 'eli', access: 'admin' } })
    expect(() => readFileSync(join(e.dir, 'setup-token'))).toThrow()
    const again = await e.app.request(
      '/api/auth/setup',
      json('POST', { token: e.setupToken, username: 'y', password: 'long enough' }),
    )
    expect(again.status).toBe(401)
  })
})

describe('signing in', () => {
  it('keeps everything but health and signing in behind a session', async () => {
    const e = engine()
    expect((await e.app.request('/api/health')).status).toBe(200)
    expect((await e.app.request('/api/board')).status).toBe(401)
    expect((await e.app.request('/api/items', json('POST', { title: 'x' }))).status).toBe(401)
    expect((await e.app.request('/mcp', { method: 'POST' })).status).toBe(401)
    const cookie = await firstAdmin(e)
    expect((await e.app.request('/api/board', { headers: { Cookie: cookie } })).status).toBe(200)
  })

  it('says the same for a wrong password and an unknown username', async () => {
    const e = engine()
    await firstAdmin(e)
    const [a, b] = [await login(e.app, 'eli', 'nope nope'), await login(e.app, 'who', 'nope nope')]
    expect([a.status, b.status]).toEqual([401, 401])
    expect(await a.json()).toEqual(await b.json())
    expect((await login(e.app, 'eli', 'admin pass')).status).toBe(200)
  })

  it('slows a username down only after five failures in a row, up to 30 seconds', async () => {
    const e = engine()
    await firstAdmin(e)
    for (let i = 0; i < 5; i++) await login(e.app, 'eli', 'wrong')
    expect(slept).toEqual([])
    for (let i = 0; i < 7; i++) await login(e.app, 'eli', 'wrong')
    expect(slept).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    await login(e.app, 'someone-else', 'wrong')
    expect(slept).toHaveLength(7)
    slept = []
    expect((await login(e.app, 'eli', 'admin pass')).status).toBe(200)
    await login(e.app, 'eli', 'wrong')
    expect(slept).toEqual([30000])
    await login(e.app, 'eli', 'wrong')
    expect(slept).toEqual([30000])
  })

  it('ends a session at its ttl, at sign-out, and when the ttl changes', async () => {
    const e = engine()
    const cookie = await firstAdmin(e)
    const board = (app: App) => app.request('/api/board', { headers: { Cookie: cookie } })
    now += 7 * 86400 * 1000 - 1000
    expect((await board(e.app)).status).toBe(200)
    const changed = engine({ ttl: '30d', ttlSeconds: 30 * 86400 }, e)
    expect((await board(changed.app)).status).toBe(401)
    expect((await board(e.app)).status).toBe(401)

    const fresh = cookieOf(await login(e.app, 'eli', 'admin pass'))
    now += 7 * 86400 * 1000
    expect((await e.app.request('/api/board', { headers: { Cookie: fresh } })).status).toBe(401)

    const third = cookieOf(await login(e.app, 'eli', 'admin pass'))
    await e.app.request('/api/auth/logout', { method: 'POST', headers: { Cookie: third } })
    expect((await e.app.request('/api/board', { headers: { Cookie: third } })).status).toBe(401)
  })
})

describe('accounts', () => {
  async function withMember(e: ReturnType<typeof engine>) {
    const admin = await firstAdmin(e)
    const created = await e.app.request(
      '/api/accounts',
      json('POST', { username: 'amy', password: 'member pass' }, admin),
    )
    expect(created.status).toBe(201)
    const amy = (await created.json()) as { userId: string; access: string }
    expect(amy.access).toBe('member')
    return { admin, amy, member: cookieOf(await login(e.app, 'amy', 'member pass')) }
  }

  it('only an admin manages them', async () => {
    const e = engine()
    const { admin, amy, member } = await withMember(e)
    expect((await e.app.request('/api/accounts', { headers: { Cookie: member } })).status).toBe(403)
    const raised = await e.app.request(
      `/api/accounts/${amy.userId}`,
      json('PATCH', { access: 'maintainer' }, admin),
    )
    expect(await raised.json()).toMatchObject({ access: 'maintainer' })
  })

  it('a person’s comments and actions carry their name', async () => {
    const e = engine()
    const { member } = await withMember(e)
    const item = (await (
      await e.app.request('/api/items', json('POST', { title: 'x' }, member))
    ).json()) as {
      ref: string
    }
    await e.app.request(`/api/items/${item.ref}/comments`, json('POST', { body: 'hi' }, member))
    await e.app.request(`/api/items/${item.ref}/hold`, {
      method: 'PUT',
      headers: { Cookie: member },
    })
    const detail = (await (
      await e.app.request(`/api/items/${item.ref}`, { headers: { Cookie: member } })
    ).json()) as {
      comments: Comment[]
    }
    expect(detail.comments.map((c) => [c.authorName, c.kind])).toEqual([
      ['amy', 'note'],
      ['amy', 'system'],
    ])
  })

  it('disabling one ends its sessions and tokens at once', async () => {
    const e = engine()
    const { admin, amy, member } = await withMember(e)
    const token = (await (
      await e.app.request('/api/tokens', json('POST', { name: 'cli' }, member))
    ).json()) as {
      token: string
    }
    await e.app.request(`/api/accounts/${amy.userId}`, json('PATCH', { disabled: true }, admin))
    expect((await e.app.request('/api/board', { headers: { Cookie: member } })).status).toBe(401)
    const mcp = await e.app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.token}` },
    })
    expect(mcp.status).toBe(401)
    expect((await login(e.app, 'amy', 'member pass')).status).toBe(401)
  })
})

describe('personal API tokens', () => {
  const connect = async (app: App, token: string): Promise<Client> => {
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: (url, init) => Promise.resolve(app.request(String(url), init)),
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
    return client
  }

  it('let /mcp in as their owner until revoked, and the cookie never does', async () => {
    const e = engine()
    const admin = await firstAdmin(e)
    const res = await e.app.request('/api/tokens', json('POST', { name: 'laptop' }, admin))
    const issued = (await res.json()) as { id: string; token: string; name: string }
    expect(issued.name).toBe('laptop')
    const listed = (await (
      await e.app.request('/api/tokens', { headers: { Cookie: admin } })
    ).json()) as object[]
    expect(listed).toEqual([
      { id: issued.id, userId: expect.any(String), name: 'laptop', createdAt: expect.any(String) },
    ])

    const client = await connect(e.app, issued.token)
    await client.callTool({ name: 'create_item', arguments: { title: 'via mcp' } })
    const board = await e.app.request('/api/board', { headers: { Cookie: admin } })
    expect(JSON.stringify(await board.json())).toContain('via mcp')

    const withCookie = await e.app.request('/mcp', { method: 'POST', headers: { Cookie: admin } })
    expect(withCookie.status).toBe(401)
    await e.app.request(`/api/tokens/${issued.id}`, {
      method: 'DELETE',
      headers: { Cookie: admin },
    })
    await expect(connect(e.app, issued.token)).rejects.toThrow()
  })

  it('stop working once past their expiry', async () => {
    const e = engine()
    const admin = await firstAdmin(e)
    const expiresAt = new Date(now + 3600_000).toISOString()
    const { token } = (await (
      await e.app.request('/api/tokens', json('POST', { name: 'x', expiresAt }, admin))
    ).json()) as {
      token: string
    }
    const mcp = () =>
      e.app.request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    expect((await mcp()).status).not.toBe(401)
    now += 3600_000
    expect((await mcp()).status).toBe(401)
  })
})

describe('requests from elsewhere', () => {
  it('are refused for a Host that is not this machine, and a write from another site', async () => {
    const e = engine()
    expect((await e.app.request('http://evil.example/api/health')).status).toBe(403)
    const cookie = await firstAdmin(e)
    const cross = await e.app.request('/api/items', {
      ...json('POST', { title: 'x' }, cookie),
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'http://evil.example',
      },
    })
    expect(cross.status).toBe(403)
    const same = await e.app.request('/api/items', {
      ...json('POST', { title: 'x' }, cookie),
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'http://localhost:5173',
      },
    })
    expect(same.status).toBe(201)
  })
})
