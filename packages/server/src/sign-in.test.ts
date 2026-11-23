import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createBuiltinAuth } from '@tasuki/auth-builtin'
import {
  createStatusMap,
  type AuthPort,
  type Comment,
  type StorePort,
  type Workflow,
} from '@tasuki/core'
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
import { createLiveInstance } from './instance'
import { createApp } from './app'
import { createLiveFlow } from './flow'
import { createRunTokens } from './run-tokens'
import { createLoginThrottle, createSetupToken, createSignIns } from './sign-ins'

const mapping = { item: { refining: 'Refining', done: 'Done' } }
const statuses = createStatusMap(mapping)
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
  opts: { port?: (store: StorePort) => AuthPort; publicUrl?: string; agentHost?: string } = {},
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
    flow: createLiveFlow(
      { agents: [], defaultMaxAttempts: 3 },
      { flow: { workflow, statuses: mapping, rules: [], holdLabel: 'hold' }, raw: {} },
    ),
    instance: createLiveInstance({ pollSeconds: 5 }),
    agents: [],
    tokens: createRunTokens(),
    auth: {
      port: (opts.port ?? createBuiltinAuth)(store),
      signIns: createSignIns(store, clock, ttl),
      throttle: createLoginThrottle(async (ms) => void slept.push(ms)),
      setup,
      ttlSeconds: ttl.ttlSeconds,
    },
    ...(opts.publicUrl === undefined ? {} : { publicUrl: opts.publicUrl }),
    ...(opts.agentHost === undefined ? {} : { agentHost: opts.agentHost }),
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

  it('an admin and a maintainer edit the flow; a member does not even read it (D91)', async () => {
    const e = engine()
    const { admin, amy, member } = await withMember(e)
    const cookie = (c: string) => ({ headers: { Cookie: c } })
    expect((await e.app.request('/api/flow', cookie(member))).status).toBe(403)
    expect((await e.app.request('/api/flow', json('PUT', { flow: {} }, member))).status).toBe(403)
    expect((await e.app.request('/api/flow', cookie(admin))).status).toBe(200)
    await e.app.request(
      `/api/accounts/${amy.userId}`,
      json('PATCH', { access: 'maintainer' }, admin),
    )
    expect((await e.app.request('/api/flow', cookie(member))).status).toBe(200)
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

describe('accounts from an outside system', () => {
  // Stands in for auth-http: the outside system knows eli, and may rename him.
  let names: Record<string, string>
  const outside = (): AuthPort => ({
    login: async ({ username, password }) =>
      names[username] !== undefined && password === 'company pw'
        ? { userId: `ext-${username}`, displayName: names[username] }
        : undefined,
  })
  beforeEach(() => {
    names = { eli: 'Eli Ye', amy: 'Amy' }
  })
  const login = (e: ReturnType<typeof engine>, username: string) =>
    e.app.request('/api/auth/login', json('POST', { username, password: 'company pw' }))

  const setUp = (e: ReturnType<typeof engine>, username: string) =>
    e.app.request(
      '/api/auth/setup',
      json('POST', { token: e.setupToken, username, password: 'company pw' }),
    )

  it('make the first admin from the setup token and company credentials, and nobody else gets in unasked', async () => {
    const e = engine(undefined, undefined, { port: outside })
    const state = await (await e.app.request('/api/auth/state')).json()
    expect(state).toMatchObject({ mode: 'external', needsSetup: true })
    // On nobody's list yet, the company saying yes is not enough.
    expect((await login(e, 'eli')).status).toBe(401)
    expect(
      (
        await e.app.request(
          '/api/auth/setup',
          json('POST', { token: e.setupToken, username: 'eli', password: 'wrong' }),
        )
      ).status,
    ).toBe(401)
    const res = await setUp(e, 'eli')
    expect(res.status).toBe(200)
    expect((await res.json()).me).toMatchObject({
      username: 'eli',
      displayName: 'Eli Ye',
      access: 'admin',
      externalId: 'ext-eli',
    })
    const admin = cookieOf(res)
    expect((await e.app.request('/api/board', { headers: { Cookie: admin } })).status).toBe(200)
    expect((await login(e, 'amy')).status).toBe(401)
    const added = await e.app.request(
      '/api/accounts/batch',
      json('POST', { usernames: ['amy', 'bob', 'eli'], access: 'member' }, admin),
    )
    expect(added.status).toBe(201)
    const body = await added.json()
    expect(body.added.map((a: { username: string }) => a.username)).toEqual(['amy', 'bob'])
    expect(body.existing).toEqual(['eli'])
    const amy = await login(e, 'amy')
    expect(amy.status).toBe(200)
    expect((await amy.json()).me).toMatchObject({ displayName: 'Amy', access: 'member' })
    // One at a time with a password is for accounts tasuki keeps.
    const made = await e.app.request(
      '/api/accounts',
      json('POST', { username: 'cat', password: 'long enough' }, admin),
    )
    expect(made.status).toBe(400)
  })

  it('take the company’s current name at every sign in; a deleted or disabled one stays out', async () => {
    const e = engine(undefined, undefined, { port: outside })
    const admin = cookieOf(await setUp(e, 'eli'))
    const { added } = await (
      await e.app.request('/api/accounts/batch', json('POST', { usernames: ['amy'] }, admin))
    ).json()
    const amyId = added[0].userId
    const amy = cookieOf(await login(e, 'amy'))
    names['amy'] = 'Amy Lin'
    expect((await (await login(e, 'amy')).json()).me.displayName).toBe('Amy Lin')
    await e.app.request(`/api/accounts/${amyId}`, json('PATCH', { disabled: true }, admin))
    expect((await login(e, 'amy')).status).toBe(401)
    const gone = await e.app.request(`/api/accounts/${amyId}`, {
      method: 'DELETE',
      headers: { Cookie: admin },
    })
    expect(gone.status).toBe(200)
    expect((await login(e, 'amy')).status).toBe(401)
    expect((await e.app.request('/api/board', { headers: { Cookie: amy } })).status).toBe(401)
    const self = await e.app.request('/api/accounts', { headers: { Cookie: admin } })
    const me = (await self.json())[0]
    expect(
      (
        await e.app.request(`/api/accounts/${me.userId}`, {
          method: 'DELETE',
          headers: { Cookie: admin },
        })
      ).status,
    ).toBe(400)
  })
})

describe('behind a proxy at publicUrl', () => {
  it('takes its Host and Origin, still refuses other sites, and sets the cookie Secure', async () => {
    const e = engine(undefined, undefined, { publicUrl: 'https://tasuki.example' })
    expect((await e.app.request('https://tasuki.example/api/health')).status).toBe(200)
    expect((await e.app.request('https://evil.example/api/health')).status).toBe(403)
    const res = await e.app.request('https://tasuki.example/api/auth/setup', {
      ...json('POST', { token: e.setupToken, username: 'eli', password: 'admin pass' }),
      headers: { 'Content-Type': 'application/json', Origin: 'https://tasuki.example' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Set-Cookie')).toContain('Secure')
    const cookie = cookieOf(res)
    const write = (origin: string) =>
      e.app.request('https://tasuki.example/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
        body: JSON.stringify({ title: 'x' }),
      })
    expect((await write('https://tasuki.example')).status).toBe(201)
    expect((await write('https://evil.example')).status).toBe(403)
    // Same host, other scheme: not the origin people open.
    expect((await write('http://tasuki.example')).status).toBe(403)
  })

  it('keeps the cookie plain on loopback, and lets agents in at the bound address only for /agent-mcp', async () => {
    const e = engine(undefined, undefined, { agentHost: '10.0.0.5' })
    const res = await e.app.request(
      '/api/auth/setup',
      json('POST', { token: e.setupToken, username: 'eli', password: 'admin pass' }),
    )
    expect(res.headers.get('Set-Cookie')).not.toContain('Secure')
    expect((await e.app.request('http://10.0.0.5/api/health')).status).toBe(403)
    expect((await e.app.request('http://10.0.0.5/agent-mcp', { method: 'POST' })).status).not.toBe(
      403,
    )
  })
})
