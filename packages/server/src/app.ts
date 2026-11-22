import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  ACCESS_LEVELS,
  addAttachment,
  assertPassword,
  changeOwnPassword,
  addAccounts,
  createAccount,
  deleteAccount,
  Forbidden,
  listAccounts,
  needsSetup,
  resetPassword,
  setAccess,
  setDisabled,
  setUpFirstAdmin,
  signIn,
  type Access,
  type Account,
  type AuthPort,
  deleteAttachment,
  addComment,
  createItem,
  deleteItem,
  deleteTask,
  EditConflict,
  getItem,
  getTask,
  holdItem,
  InvalidInput,
  listBoard,
  MAX_ATTACHMENT_BYTES,
  moveItem,
  moveTask,
  NotFound,
  pauseEngine,
  releaseItem,
  requestRework,
  resumeEngine,
  StatusConflict,
  stopRun,
  updateItem,
  updateTask,
  type Rule,
  type StorePort,
  type StatusMap,
  type Workflow,
  type TrackerPort,
} from '@tasuki/core'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createAgentMcpServer } from './agent-mcp'
import { createMcpServer } from './mcp'
import type { RunTokens } from './run-tokens'
import type { LoginThrottle, SetupToken, SignIns } from './sign-ins'

// encodeURIComponent leaves ' ( ) * alone, which RFC 5987 does not allow unencoded.
const encodeRfc5987 = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface AppAuth {
  port: AuthPort
  signIns: SignIns
  throttle: LoginThrottle
  setup: SetupToken
  ttlSeconds?: number
}

export interface AppDeps {
  tracker: TrackerPort
  store: StorePort
  statuses: StatusMap
  workflow: Workflow
  rules: readonly Rule[]
  holdLabel: string
  tokens: RunTokens
  // Unset: nobody signs in, and every request acts as an admin.
  auth?: AppAuth
  // The address people open through the proxy (S9c); its host and origin pass the checks below.
  publicUrl?: string
  // The host agents reach /agent-mcp at, when the engine is bound to one address that is not
  // loopback.
  agentHost?: string
}

const SESSION_COOKIE = 'tasuki_session'
// What a browser keeps a cookie for at most; the store decides when a session really ends.
const NEVER_SECONDS = 400 * 86400

const LOCAL: Account = {
  userId: 'local',
  username: '',
  displayName: '',
  access: 'admin',
  disabled: false,
  createdAt: '',
}

// A page on another site that gets the browser to reach 127.0.0.1 by DNS rebinding still
// sends its own name as the Host.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const hostOf = (value: string): string | undefined => {
  try {
    return new URL(value).hostname
  } catch {
    return undefined
  }
}

// Every human comment written while serving a signed-in request carries that person's name;
// the engine's own writes run outside any request and carry none.
function namingComments(tracker: TrackerPort, current: () => string | undefined): TrackerPort {
  return Object.assign(Object.create(tracker) as TrackerPort, {
    addComment: (comment: Parameters<TrackerPort['addComment']>[0]) => {
      const name = current()
      return tracker.addComment(
        comment.author === 'human' && name ? { ...comment, authorName: name } : comment,
      )
    },
  })
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function createApp({
  tracker: plainTracker,
  store,
  statuses,
  workflow,
  rules,
  holdLabel,
  tokens,
  auth,
  publicUrl,
  agentHost,
}: AppDeps): Hono<{ Variables: { actor: Account } }> {
  const signedIn = new AsyncLocalStorage<Account>()
  const tracker =
    auth === undefined
      ? plainTracker
      : namingComments(plainTracker, () => signedIn.getStore()?.displayName)
  const hosts = new Set(LOOPBACK)
  const publicOrigin = publicUrl === undefined ? undefined : new URL(publicUrl)
  if (publicOrigin !== undefined) hosts.add(publicOrigin.hostname)
  const app = new Hono<{ Variables: { actor: Account } }>()
  app.onError((e, c) => {
    if (e instanceof InvalidInput) return c.json({ error: e.message }, 400)
    if (e instanceof Forbidden) return c.json({ error: e.message }, 403)
    if (e instanceof NotFound) return c.json({ error: e.message }, 404)
    // The board puts the card where it really is.
    if (e instanceof StatusConflict || e instanceof EditConflict)
      return c.json({ error: e.message, item: e.current }, 409)
    return c.json({ error: e.message }, 500)
  })
  app.use(async (c, next) => {
    // The Node adapter builds the URL from the Host header.
    const host = hostOf(c.req.url) ?? ''
    if (!hosts.has(host) && !(c.req.path === '/agent-mcp' && host === agentHost))
      return c.json({ error: 'unexpected Host' }, 403)
    // CSRF: SameSite=Lax stops most cross-site writes; this covers the rest. A client that
    // is not a browser sends no Origin and is not who CSRF is about.
    const origin = c.req.header('Origin')
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      origin !== undefined &&
      !LOOPBACK.has(hostOf(origin) ?? '') &&
      origin !== publicOrigin?.origin
    )
      return c.json({ error: 'cross-site request' }, 403)
    return next()
  })
  app.get('/api/health', (c) => c.json({ ok: true }))

  const sessionOf = async (c: Context): Promise<Account | undefined> => {
    const token = getCookie(c, SESSION_COOKIE)
    return token === undefined ? undefined : auth?.signIns.resolve(token)
  }
  const startSession = async (c: Context, account: Account): Promise<void> => {
    if (auth === undefined) return
    setCookie(c, SESSION_COOKIE, await auth.signIns.start(account.userId), {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: auth.ttlSeconds ?? NEVER_SECONDS,
      // Only over https: some browsers drop a Secure cookie on http://localhost (D89).
      ...(publicOrigin?.protocol === 'https:' ? { secure: true } : {}),
    })
  }

  // Asking who is signed in, signing in, and the first admin are open; everything else needs
  // an account, unless a route is added to this list on purpose.
  const OPEN = new Set(['/api/health', '/api/auth/state', '/api/auth/login', '/api/auth/setup'])
  app.use(async (c, next) => {
    const path = c.req.path
    if (OPEN.has(path) || path === '/agent-mcp' || !(path.startsWith('/api/') || path === '/mcp'))
      return next()
    let actor: Account | undefined = LOCAL
    if (auth !== undefined) {
      // /mcp takes the Bearer token only, never the board's cookie.
      const bearer = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1]
      actor =
        path === '/mcp'
          ? bearer === undefined
            ? undefined
            : await auth.signIns.resolveApiToken(bearer)
          : await sessionOf(c)
    }
    if (actor === undefined) return c.json({ error: 'sign in first' }, 401)
    c.set('actor', actor)
    return signedIn.run(actor, next)
  })

  app.get('/api/auth/state', async (c) => {
    const mode = auth === undefined ? 'none' : auth.port.accounts ? 'builtin' : 'external'
    const me = auth === undefined ? LOCAL : await sessionOf(c)
    return c.json({
      mode,
      needsSetup: auth !== undefined && auth.setup.open() && (await needsSetup(store)),
      ...(me === undefined ? {} : { me }),
    })
  })
  app.post('/api/auth/login', async (c) => {
    if (auth === undefined) throw new InvalidInput('nobody signs in here')
    const body = await c.req.json<{ username?: unknown; password?: unknown }>()
    const credentials = { username: text(body.username).trim(), password: text(body.password) }
    await auth.throttle.wait(credentials.username)
    const account = await signIn({ auth: auth.port, store }, credentials)
    if (account === undefined) {
      auth.throttle.failed(credentials.username)
      return c.json({ error: 'wrong username or password' }, 401)
    }
    auth.throttle.succeeded(credentials.username)
    await startSession(c, account)
    return c.json({ me: account })
  })
  app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE)
    if (token !== undefined) await auth?.signIns.end(token)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })
  app.post('/api/auth/setup', async (c) => {
    if (auth === undefined) throw new InvalidInput('nobody signs in here')
    const body = await c.req.json<{ token?: unknown; username?: unknown; password?: unknown }>()
    // A guessable-looking endpoint, so guesses at it are slowed like a password's.
    await auth.throttle.wait('#setup')
    if (!auth.setup.matches(text(body.token).trim())) {
      auth.throttle.failed('#setup')
      return c.json({ error: 'that is not the setup token' }, 401)
    }
    auth.throttle.succeeded('#setup')
    if (auth.port.accounts !== undefined) assertPassword(text(body.password))
    const admin = await setUpFirstAdmin(
      { auth: auth.port, store },
      { username: text(body.username), password: text(body.password) },
    )
    if (admin === undefined) return c.json({ error: 'wrong username or password' }, 401)
    await startSession(c, admin)
    auth.setup.close()
    return c.json({ me: admin })
  })
  app.put('/api/me/password', async (c) => {
    if (auth === undefined) throw new InvalidInput('nobody signs in here')
    const body = await c.req.json<{ current?: unknown; next?: unknown }>()
    await changeOwnPassword(auth.port, c.var.actor, text(body.current), text(body.next))
    return c.json({ ok: true })
  })
  app.get('/api/accounts', async (c) => c.json(await listAccounts(store, c.var.actor)))
  app.post('/api/accounts', async (c) => {
    if (auth === undefined) throw new InvalidInput('nobody signs in here')
    const body = await c.req.json<{ username?: unknown; password?: unknown; access?: unknown }>()
    const access = body.access ?? 'member'
    if (!ACCESS_LEVELS.includes(access as Access))
      throw new InvalidInput(`access is one of ${ACCESS_LEVELS.join(', ')}`)
    const account = await createAccount(auth.port, c.var.actor, {
      username: text(body.username),
      displayName: text(body.username),
      password: text(body.password),
      access: access as Access,
    })
    return c.json(account, 201)
  })
  // From an outside system, by username: one per line when pasted from a list.
  app.post('/api/accounts/batch', async (c) => {
    if (auth === undefined) throw new InvalidInput('nobody signs in here')
    const body = await c.req.json<{ usernames?: unknown; access?: unknown }>()
    const access = body.access ?? 'member'
    if (!ACCESS_LEVELS.includes(access as Access))
      throw new InvalidInput(`access is one of ${ACCESS_LEVELS.join(', ')}`)
    const usernames = Array.isArray(body.usernames) ? body.usernames.map(text) : []
    return c.json(
      await addAccounts({ auth: auth.port, store }, c.var.actor, usernames, access as Access),
      201,
    )
  })
  app.delete('/api/accounts/:id', async (c) => {
    await deleteAccount(store, c.var.actor, c.req.param('id'))
    return c.json({ ok: true })
  })
  app.patch('/api/accounts/:id', async (c) => {
    const body = await c.req.json<{ access?: unknown; disabled?: unknown }>()
    const id = c.req.param('id')
    let account: Account | undefined
    if (body.access !== undefined) {
      if (!ACCESS_LEVELS.includes(body.access as Access))
        throw new InvalidInput(`access is one of ${ACCESS_LEVELS.join(', ')}`)
      account = await setAccess(store, c.var.actor, id, body.access as Access)
    }
    if (typeof body.disabled === 'boolean')
      account = await setDisabled(store, c.var.actor, id, body.disabled)
    if (account === undefined) throw new InvalidInput('change access or disabled')
    return c.json(account)
  })
  app.put('/api/accounts/:id/password', async (c) => {
    if (auth === undefined) throw new InvalidInput('nobody signs in here')
    const body = await c.req.json<{ password?: unknown }>()
    await resetPassword(
      { auth: auth.port, store },
      c.var.actor,
      c.req.param('id'),
      text(body.password),
    )
    return c.json({ ok: true })
  })
  // Personal API tokens for /mcp: each person sees and revokes only their own.
  app.get('/api/tokens', async (c) => c.json(await store.apiTokensOf(c.var.actor.userId)))
  app.post('/api/tokens', async (c) => {
    if (auth === undefined) throw new InvalidInput('nobody signs in here: /mcp needs no token')
    const body = await c.req.json<{ name?: unknown; expiresAt?: unknown }>()
    const { token, apiToken } = await auth.signIns.issueApiToken(
      c.var.actor.userId,
      text(body.name),
      typeof body.expiresAt === 'string' && body.expiresAt !== '' ? body.expiresAt : undefined,
    )
    return c.json({ ...apiToken, token }, 201)
  })
  app.delete('/api/tokens/:id', async (c) => {
    const id = c.req.param('id')
    if (!(await store.apiTokensOf(c.var.actor.userId)).some((t) => t.id === id))
      throw new NotFound(`you have no token ${id}`)
    await store.deleteApiToken(id)
    return c.json({ ok: true })
  })
  app.get('/api/board', async (c) =>
    c.json(await listBoard(tracker, store, workflow, statuses.mapped('task'), rules, holdLabel)),
  )
  app.post('/api/items', async (c) => {
    const body = await c.req.json<{ title?: unknown; body?: unknown }>()
    const item = await createItem(tracker, workflow.roles.entry, {
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
      await moveItem(tracker, workflow, {
        ref: c.req.param('ref'),
        from: body.from,
        to: body.to,
      }),
    )
  })
  app.post('/api/items/:ref/rework', async (c) => {
    const body = await c.req.json<{ from?: unknown; feedback?: unknown }>()
    if (typeof body.from !== 'string') throw new InvalidInput('from is required')
    return c.json(
      await requestRework(tracker, workflow, {
        ref: c.req.param('ref'),
        from: body.from,
        feedback: typeof body.feedback === 'string' ? body.feedback : '',
      }),
    )
  })
  app.post('/api/engine/pause', async (c) => {
    const body = await c.req.json<{ kill?: unknown }>().catch(() => ({}) as { kill?: unknown })
    return c.json({ stopped: await pauseEngine(store, body.kill === true) })
  })
  app.post('/api/engine/resume', async (c) => {
    await resumeEngine(store)
    return c.json({ ok: true })
  })
  app.post('/api/items/:ref/stop', async (c) =>
    c.json(await stopRun({ tracker, store }, holdLabel, c.req.param('ref'))),
  )
  app.put('/api/items/:ref/hold', async (c) =>
    c.json(await holdItem({ tracker, store }, holdLabel, c.req.param('ref'))),
  )
  app.delete('/api/items/:ref/hold', async (c) =>
    c.json(await releaseItem(tracker, holdLabel, c.req.param('ref'))),
  )
  app.delete('/api/items/:ref', async (c) => {
    await deleteItem({ tracker, store }, c.req.param('ref'))
    return c.json({ ok: true })
  })
  app.get('/api/items/:ref', async (c) => c.json(await getItem(tracker, store, c.req.param('ref'))))
  app.patch('/api/items/:ref', async (c) => {
    const body = await c.req.json<{ expectedVersion?: unknown; title?: unknown; body?: unknown }>()
    if (typeof body.expectedVersion !== 'string')
      throw new InvalidInput('expectedVersion is required')
    return c.json(
      await updateItem(tracker, {
        ref: c.req.param('ref'),
        expectedVersion: body.expectedVersion,
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.body === 'string' ? { body: body.body } : {}),
      }),
    )
  })
  app.post('/api/items/:ref/comments', async (c) => {
    const body = await c.req.json<{ body?: unknown }>()
    const comment = await addComment(tracker, {
      ref: c.req.param('ref'),
      body: typeof body.body === 'string' ? body.body : '',
    })
    return c.json(comment, 201)
  })
  app.get('/api/tasks/:ref', async (c) => c.json(await getTask(tracker, c.req.param('ref'))))
  app.post('/api/tasks/:ref/transition', async (c) => {
    const body = await c.req.json<{ from?: unknown; to?: unknown }>()
    if (typeof body.from !== 'string' || typeof body.to !== 'string')
      throw new InvalidInput('from and to are required')
    return c.json(
      await moveTask({ tracker, store }, { ref: c.req.param('ref'), from: body.from, to: body.to }),
    )
  })
  app.patch('/api/tasks/:ref', async (c) => {
    const body = await c.req.json<{ expectedVersion?: unknown; title?: unknown; body?: unknown }>()
    if (typeof body.expectedVersion !== 'string')
      throw new InvalidInput('expectedVersion is required')
    return c.json(
      await updateTask(
        { tracker, store },
        {
          ref: c.req.param('ref'),
          expectedVersion: body.expectedVersion,
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(typeof body.body === 'string' ? { body: body.body } : {}),
        },
      ),
    )
  })
  app.delete('/api/tasks/:ref', async (c) => {
    await deleteTask({ tracker, store }, c.req.param('ref'))
    return c.json({ ok: true })
  })
  app.post('/api/tasks/:ref/comments', async (c) => {
    const body = await c.req.json<{ body?: unknown }>()
    const comment = await addComment(tracker, {
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
      const attachment = await addAttachment(tracker, c.req.param('ref'), {
        filename: file.name,
        mimeType: file.type,
        data: new Uint8Array(await file.arrayBuffer()),
      })
      return c.json(attachment, 201)
    },
  )
  app.delete('/api/items/:ref/attachments/:id', async (c) => {
    await deleteAttachment(tracker, c.req.param('ref'), c.req.param('id'))
    return c.json({ ok: true })
  })
  app.get('/api/items/:ref/attachments/:id', async (c) => {
    const { attachment, data } = await tracker.readAttachment(c.req.param('ref'), c.req.param('id'))
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
    await createMcpServer({ tracker, store, statuses, workflow, rules, holdLabel }).connect(
      transport,
    )
    return transport.handleRequest(c.req.raw)
  })
  // The facade for agents the engine started: only a live Run's token gets in.
  app.all('/agent-mcp', async (c) => {
    const token = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1]
    const runId = token === undefined ? undefined : tokens.resolve(token)
    const run = runId === undefined ? undefined : await store.getRun(runId)
    const rule = rules.find((r) => r.id === run?.rule)
    if (run?.state !== 'running' || rule === undefined)
      return c.json({ error: 'not a live run token' }, 401)
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await createAgentMcpServer({ tracker, store, run, rule }).connect(transport)
    return transport.handleRequest(c.req.raw)
  })
  return app
}
