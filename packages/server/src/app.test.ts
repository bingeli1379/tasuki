import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createStatusMap, type StatusMapping, type WorkUnit, type Workflow } from '@tasuki/core'
import {
  createSqliteStore,
  createSqliteTracker,
  migrate,
  openDatabase,
  STORE_MIGRATIONS,
  TRACKER_MIGRATIONS,
} from '@tasuki/sqlite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { createLiveInstance } from './instance'
import { createApp } from './app'
import { createLiveFlow, DEFAULT_FLOW, loadFlow } from './flow'
import { defaultPrompt } from './prompts'
import { createRunTokens } from './run-tokens'

const mapping: StatusMapping = {
  item: { refining: 'Refining', 'ready-to-split': 'Ready to Split', done: 'Done' },
}
const statuses = createStatusMap(mapping)
const workflow: Workflow = {
  statuses: [
    { id: 'refining', name: 'Refining', outcomes: [] },
    { id: 'ready-to-split', name: 'Ready to Split', outcomes: [] },
    { id: 'done', name: 'Done', outcomes: [] },
  ],
  roles: { entry: 'refining', failure: 'done' },
}

// The real sqlite tracker in memory: the server is tested against a tracker that keeps
// the TrackerPort contract, not a hand-written fake that drifts from it.
const memoryTracker = (): ReturnType<typeof createSqliteTracker> => {
  const db = openDatabase(':memory:')
  migrate(db, TRACKER_MIGRATIONS)
  return createSqliteTracker(
    { clock: { now: () => new Date() }, configDir: '', dataDir: '', statuses },
    db,
    'M',
  )
}

const memoryStore = (): ReturnType<typeof createSqliteStore> => {
  const db = openDatabase(':memory:')
  migrate(db, STORE_MIGRATIONS)
  return createSqliteStore(db, { now: () => new Date() })
}

// A flow already parsed, with no rules.
const liveFlow = (statuses: StatusMapping) =>
  createLiveFlow(
    { agents: [], defaultMaxAttempts: 3 },
    { flow: { workflow, statuses, rules: [], holdLabel: 'hold' }, raw: {} },
  )

const appWith = (): ReturnType<typeof createApp> =>
  createApp({
    tracker: memoryTracker(),
    store: memoryStore(),
    flow: liveFlow(mapping),
    instance: createLiveInstance({ pollSeconds: 5 }),
    agents: [],
    tokens: createRunTokens(),
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

describe('item detail', () => {
  const PNG = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    ),
    (c) => c.charCodeAt(0),
  )
  const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })
  const created = async (app: ReturnType<typeof createApp>): Promise<WorkUnit> =>
    (await (
      await app.request('/api/items', { method: 'POST', ...json({ title: 'Login', body: '' }) })
    ).json()) as WorkUnit
  const upload = (
    app: ReturnType<typeof createApp>,
    ref: string,
    file: File,
  ): Promise<Response> | Response => {
    const form = new FormData()
    form.append('file', file)
    return app.request(`/api/items/${ref}/attachments`, { method: 'POST', body: form })
  }

  it('edits the item, comments on it, and reads it all back', async () => {
    const app = appWith()
    const item = await created(app)

    const edited = await app.request(`/api/items/${item.ref}`, {
      method: 'PATCH',
      ...json({ expectedVersion: item.version, body: '**bold**' }),
    })
    expect(edited.status).toBe(200)
    const comment = await app.request(`/api/items/${item.ref}/comments`, {
      method: 'POST',
      ...json({ body: 'ok' }),
    })
    expect(comment.status).toBe(201)

    const detail = (await (await app.request(`/api/items/${item.ref}`)).json()) as {
      item: WorkUnit
      comments: { author: string; kind: string; body: string }[]
    }
    expect(detail.item).toMatchObject({ title: 'Login', body: '**bold**' })
    expect(detail.comments).toMatchObject([{ author: 'human', kind: 'note', body: 'ok' }])
  })

  it('an edit from a replaced version is a 409 with the item as it is now', async () => {
    const app = appWith()
    const item = await created(app)
    const patch = (body: string): Promise<Response> | Response =>
      app.request(`/api/items/${item.ref}`, {
        method: 'PATCH',
        ...json({ expectedVersion: item.version, body }),
      })
    await patch('theirs')
    const res = await patch('mine')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ item: { body: 'theirs' } })
  })

  it('serves an uploaded image inline, with headers that keep it from running anything', async () => {
    const app = appWith()
    const item = await created(app)
    const res = await upload(app, item.ref, new File([PNG], 'dot.png', { type: 'image/png' }))
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }

    const file = await app.request(`/api/items/${item.ref}/attachments/${id}`)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('image/png')
    expect(file.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''dot.png")
    expect(file.headers.get('x-content-type-options')).toBe('nosniff')
    expect(file.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG)
  })

  it('an SVG or HTML upload is only ever downloaded, never shown', async () => {
    const app = appWith()
    const item = await created(app)
    for (const [name, type] of [
      ['x.svg', 'image/svg+xml'],
      ['x.html', 'text/html'],
    ] as const) {
      const res = await upload(app, item.ref, new File(['<script>1</script>'], name, { type }))
      const { id } = (await res.json()) as { id: string }
      const file = await app.request(`/api/items/${item.ref}/attachments/${id}`)
      expect(file.headers.get('content-type')).toBe('application/octet-stream')
      expect(file.headers.get('content-disposition')).toMatch(/^attachment;/)
    }
  })

  it('deletes an attachment once the body no longer shows it', async () => {
    const app = appWith()
    const item = await created(app)
    const res = await upload(app, item.ref, new File([PNG], 'dot.png', { type: 'image/png' }))
    const { id } = (await res.json()) as { id: string }
    const patch = async (body: string, version: string): Promise<WorkUnit> =>
      (await (
        await app.request(`/api/items/${item.ref}`, {
          method: 'PATCH',
          ...json({ expectedVersion: version, body }),
        })
      ).json()) as WorkUnit
    const remove = (): Promise<Response> | Response =>
      app.request(`/api/items/${item.ref}/attachments/${id}`, { method: 'DELETE' })

    const shown = await patch(`![dot.png](attachment:${id})`, item.version)
    const refused = await remove()
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({
      error: `${item.ref}'s body still shows dot.png; take it out of the body first`,
    })

    await patch('', shown.version)
    expect((await remove()).status).toBe(200)
    expect((await app.request(`/api/items/${item.ref}/attachments/${id}`)).status).toBe(404)
    expect((await remove()).status).toBe(404)
    const detail = (await (await app.request(`/api/items/${item.ref}`)).json()) as {
      attachments: unknown[]
      comments: { kind: string; body: string }[]
    }
    expect(detail.attachments).toEqual([])
    expect(detail.comments).toMatchObject([{ kind: 'system', body: 'Deleted attachment dot.png.' }])
  })

  it('a file over 10 MB is a 413', async () => {
    const app = appWith()
    const item = await created(app)
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 70 * 1024)], 'big.bin')
    expect((await upload(app, item.ref, big)).status).toBe(413)
  })
})

describe('tasks', () => {
  const taskMapping: StatusMapping = {
    item: { 'split-review': 'Split Review', 'in-progress': 'In Progress' },
    task: { 'to-do': 'To Do', manual: 'Manual', done: 'Done' },
  }
  const taskStatuses = createStatusMap(taskMapping)
  const setup = async () => {
    const db = openDatabase(':memory:')
    migrate(db, TRACKER_MIGRATIONS)
    const tracker = createSqliteTracker(
      { clock: { now: () => new Date() }, configDir: '', dataDir: '', statuses: taskStatuses },
      db,
      'M',
    )
    const store = memoryStore()
    const app = createApp({
      tracker,
      store,
      flow: liveFlow(taskMapping),
      instance: createLiveInstance({ pollSeconds: 5 }),
      agents: [],
      tokens: createRunTokens(),
    })
    const item = await tracker.createItem({ title: 'Item', body: '', status: 'split-review' })
    const task = (title: string, blockedBy: string[] = []) =>
      tracker.createTask(item.ref, {
        title,
        body: '',
        status: 'to-do',
        origin: 'splitter',
        blockedBy,
      })
    const first = await task('Prepare')
    const second = await task('Build', [first.ref])
    return { app, store, item, first, second }
  }
  const send = (method: string, body: unknown): RequestInit => ({
    method,
    body: JSON.stringify(body),
  })

  it('reads a task with what it waits for, comments on it, and takes it over', async () => {
    const { app, second } = await setup()
    await app.request(`/api/tasks/${second.ref}/comments`, send('POST', { body: 'mine now' }))
    const moved = await app.request(
      `/api/tasks/${second.ref}/transition`,
      send('POST', { from: 'to-do', to: 'manual' }),
    )
    expect(await moved.json()).toMatchObject({ status: 'manual' })
    expect(await (await app.request(`/api/tasks/${second.ref}`)).json()).toMatchObject({
      task: { ref: second.ref, status: 'manual', blockedBy: [expect.any(String)] },
      comments: [
        { author: 'human', kind: 'note', body: 'mine now' },
        { author: 'human', kind: 'system', body: 'Moved **To Do** → **Manual**.' },
      ],
    })
  })

  it('a move off the task diagram is a 400, a stale one a 409', async () => {
    const { app, first } = await setup()
    const off = await app.request(
      `/api/tasks/${first.ref}/transition`,
      send('POST', { from: 'to-do', to: 'done' }),
    )
    expect(off.status).toBe(400)
    expect(await off.json()).toEqual({ error: `${first.ref} cannot go from to-do to done` })
    const stale = await app.request(
      `/api/tasks/${first.ref}/transition`,
      send('POST', { from: 'manual', to: 'done' }),
    )
    expect(stale.status).toBe(409)
  })

  it('edits and deletes a task, and refuses while an agent works on its item', async () => {
    const { app, store, item, first, second } = await setup()
    const edited = await app.request(
      `/api/tasks/${first.ref}`,
      send('PATCH', { expectedVersion: first.version, title: 'Prepare well' }),
    )
    expect(await edited.json()).toMatchObject({ title: 'Prepare well' })
    expect((await app.request(`/api/tasks/${second.ref}`, { method: 'DELETE' })).status).toBe(200)
    expect((await app.request(`/api/tasks/${second.ref}`)).status).toBe(404)

    await store.createRun({
      target: item.ref,
      item: item.ref,
      rule: 'execute',
      agent: 'fake',
      attempt: 1,
      from: 'in-progress',
      workspace: '/w',
      leaseSeconds: 60,
    })
    const refused = await app.request(`/api/tasks/${first.ref}`, { method: 'DELETE' })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({
      error: `an agent is working on ${item.ref}; stop it before changing ${first.ref}`,
    })
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
    expect(tools.map((t) => t.name)).toEqual([
      'list_board',
      'create_item',
      'move_item',
      'request_rework',
      'hold_item',
      'release_item',
      'stop_run',
      'pause_engine',
      'resume_engine',
      'get_item',
      'update_item',
      'delete_item',
      'get_task',
      'move_task',
      'update_task',
      'delete_task',
      'add_comment',
      'add_attachment',
      'delete_attachment',
      'get_attachment',
    ])
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

  it('reads, edits and comments on an item, and hands an image back as an image', async () => {
    const client = await connect()
    const item = JSON.parse(
      text(await client.callTool({ name: 'create_item', arguments: { title: 'From Claude' } })),
    ) as WorkUnit
    await client.callTool({
      name: 'update_item',
      arguments: { ref: item.ref, version: item.version, body: 'new body' },
    })
    await client.callTool({ name: 'add_comment', arguments: { ref: item.ref, body: 'hi' } })
    const attachment = JSON.parse(
      text(
        await client.callTool({
          name: 'add_attachment',
          arguments: {
            ref: item.ref,
            filename: 'dot.png',
            mimeType: 'image/png',
            base64:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
          },
        }),
      ),
    ) as { id: string }

    const detail = JSON.parse(
      text(await client.callTool({ name: 'get_item', arguments: { ref: item.ref } })),
    ) as { item: WorkUnit; comments: { body: string }[]; attachments: { filename: string }[] }
    expect(detail.item.body).toBe('new body')
    expect(detail.comments.map((c) => c.body)).toEqual(['hi'])
    expect(detail.attachments.map((a) => a.filename)).toEqual(['dot.png'])

    const image = await client.callTool({
      name: 'get_attachment',
      arguments: { ref: item.ref, id: attachment.id },
    })
    expect(image.content).toMatchObject([{ type: 'image', mimeType: 'image/png' }])

    await client.callTool({
      name: 'delete_attachment',
      arguments: { ref: item.ref, id: attachment.id },
    })
    const after = JSON.parse(
      text(await client.callTool({ name: 'get_item', arguments: { ref: item.ref } })),
    ) as { attachments: unknown[] }
    expect(after.attachments).toEqual([])
  })
})

describe('the flow settings (D91)', () => {
  // The flow out of the store, with the tracker keyed by it, as the server starts.
  const setup = async () => {
    const store = memoryStore()
    const flow = await loadFlow(store, { agents: ['fake'], defaultMaxAttempts: 3 })
    const db = openDatabase(':memory:')
    migrate(db, TRACKER_MIGRATIONS)
    const tracker = createSqliteTracker(
      { clock: { now: () => new Date() }, configDir: '', dataDir: '', statuses: flow.statuses },
      db,
      'M',
    )
    const app = createApp({
      tracker,
      store,
      flow,
      instance: createLiveInstance({ pollSeconds: 5 }),
      agents: ['fake'],
      tokens: createRunTokens(),
    })
    return { app, tracker }
  }
  const put = (app: ReturnType<typeof createApp>, version: number | undefined, flow: unknown) =>
    app.request('/api/flow', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(version === undefined ? {} : { version }), flow }),
    })
  const stations = DEFAULT_FLOW['workflow'] as { statuses: { id: string; name: string }[] }
  const withStations = (statuses: unknown[], entry = 'refining') => ({
    ...DEFAULT_FLOW,
    workflow: { ...stations, statuses, roles: { entry, failure: 'blocked' } },
  })

  it('starts on the default, never saved, with what the form picks from', async () => {
    const { app } = await setup()
    expect(await (await app.request('/api/flow')).json()).toEqual({
      flow: DEFAULT_FLOW,
      agents: ['fake'],
      defaultMaxAttempts: 3,
      prompts: {
        split: defaultPrompt('split'),
        execute: defaultPrompt('execute'),
        dispatch: defaultPrompt('dispatch'),
        rework: defaultPrompt('rework'),
        review: defaultPrompt('review'),
        custom: '',
      },
      // sqlite takes any key.
      trackerStatuses: null,
    })
  })

  it('a save shows on the board at once, and a save from an older version is a 409', async () => {
    const { app } = await setup()
    const added = withStations([...stations.statuses, { id: 'ai-review', name: 'AI Review' }])
    const saved = await put(app, undefined, added)
    expect(await saved.json()).toEqual({ version: 1 })
    const board = (await (await app.request('/api/board')).json()) as {
      columns: { status: string }[]
      unmatched: string[]
    }
    expect(board.columns.map((c) => c.status).at(-1)).toBe('ai-review')
    expect(board.unmatched).toEqual([])
    expect(await (await app.request('/api/flow')).json()).toMatchObject({ version: 1, flow: added })

    const stale = await put(app, undefined, DEFAULT_FLOW)
    expect(stale.status).toBe(409)
    expect(await (await app.request('/api/flow')).json()).toMatchObject({ version: 1 })
  })

  it('the history lists every save newest first, each against the one before it (W4b)', async () => {
    const { app } = await setup()
    expect(await (await app.request('/api/flow/history')).json()).toEqual({ versions: [] })
    const added = withStations([...stations.statuses, { id: 'ai-review', name: 'AI Review' }])
    await put(app, undefined, added)
    await put(app, 1, { ...added, labels: { hold: 'paused' } })
    const { versions } = (await (await app.request('/api/flow/history')).json()) as {
      versions: { version: number; flow: unknown; changes: { text: string }[] }[]
    }
    expect(versions.map((v) => [v.version, v.changes.map((c) => c.text)])).toEqual([
      [2, ['Hold label: hold → paused']],
      [1, ['Added the status AI Review (ai-review)']],
    ])
    // Restoring is saving an old one again, through the same checks as any save.
    expect(await (await put(app, 2, versions[1]?.flow)).json()).toEqual({ version: 3 })
    const after = (await (await app.request('/api/flow/history')).json()) as {
      versions: typeof versions
    }
    expect(after.versions[0]?.changes.map((c) => c.text)).toEqual(['Hold label: paused → hold'])
  })

  it('refuses a flow that cannot work, saying where', async () => {
    const { app } = await setup()
    const res = await put(app, undefined, {
      ...DEFAULT_FLOW,
      rules: [{ id: 'split', watch: 'ready-to-split', agent: 'claude', mode: 'split' }],
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: `rules[0] (split).agent: no agent "claude" in the config file's agents`,
    })
  })

  it('a new display name is fine with items on it; a new id is not, and names them', async () => {
    const { app, tracker } = await setup()
    const item = await tracker.createItem({
      title: 'Login page',
      body: '',
      status: 'needs-answers',
    })
    const renamed = (to: { id: string; name: string }) =>
      withStations(stations.statuses.map((s) => (s.id === 'needs-answers' ? { ...s, ...to } : s)))
    expect(
      (await put(app, undefined, renamed({ id: 'needs-answers', name: 'Asked' }))).status,
    ).toBe(200)
    const board = (await (await app.request('/api/board')).json()) as {
      columns: { status: string; displayName: string; items: unknown[] }[]
    }
    expect(board.columns.find((c) => c.status === 'needs-answers')).toMatchObject({
      displayName: 'Asked',
      items: [{ ref: item.ref }],
    })

    const moved = await put(app, 1, renamed({ id: 'asked', name: 'Asked' }))
    expect(moved.status).toBe(400)
    expect(await moved.json()).toEqual({
      error: `move these off the statuses removed, rekeyed or no longer first of a shared key: ${item.ref} (needs-answers)`,
    })
  })
})

describe('the built board', () => {
  it('serves the page and its assets at / next to the API', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'tasuki-web-'))
    mkdirSync(join(webDir, 'assets'))
    writeFileSync(join(webDir, 'index.html'), '<div id="app"></div>')
    writeFileSync(join(webDir, 'assets', 'app.js'), 'export {}')
    const app = createApp({
      tracker: memoryTracker(),
      store: memoryStore(),
      flow: liveFlow(mapping),
      instance: createLiveInstance({ pollSeconds: 5 }),
      agents: [],
      tokens: createRunTokens(),
      webDir,
    })
    const page = await app.request('/')
    expect(page.headers.get('Content-Type')).toContain('text/html')
    expect(await page.text()).toBe('<div id="app"></div>')
    expect((await app.request('/assets/app.js')).status).toBe(200)
    expect(await (await app.request('/api/health')).json()).toEqual({ ok: true })
  })
})

describe('instance settings (D105)', () => {
  const setup = async () => {
    const store = memoryStore()
    const flow = await loadFlow(store, { agents: ['fake'], defaultMaxAttempts: 3 })
    const instance = createLiveInstance({ pollSeconds: 5 })
    const app = createApp({
      tracker: memoryTracker(),
      store,
      flow,
      instance,
      agents: ['fake'],
      tokens: createRunTokens(),
    })
    return { app, flow, instance }
  }
  const put = (app: ReturnType<typeof createApp>, version: number | undefined, value: unknown) =>
    app.request('/api/instance', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(version === undefined ? {} : { version }), instance: value }),
    })

  it('starts on the defaults, never saved', async () => {
    const { app } = await setup()
    expect(await (await app.request('/api/instance')).json()).toEqual({
      instance: {
        poll: { intervalSeconds: 5 },
        limits: {
          maxConcurrentRuns: 2,
          leaseSeconds: 120,
          defaultMaxAttempts: 3,
          softGraceSeconds: 300,
          hardGraceSeconds: 10,
        },
      },
    })
  })

  it('a save applies at once, and a save from an older version is a 409', async () => {
    const { app, instance } = await setup()
    expect(await (await put(app, undefined, { poll: { intervalSeconds: 2 } })).json()).toEqual({
      version: 1,
    })
    expect(instance.current().pollSeconds).toBe(2)
    expect(await (await app.request('/api/instance')).json()).toMatchObject({
      version: 1,
      instance: { poll: { intervalSeconds: 2 } },
    })
    expect((await put(app, undefined, {})).status).toBe(409)
    expect(instance.current().pollSeconds).toBe(2)
  })

  it('refuses settings that cannot work, saying where, and keeps the ones in use', async () => {
    const { app, instance } = await setup()
    const res = await put(app, undefined, { limits: { leaseSeconds: 0 } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'limits.leaseSeconds must be a whole number of at least 1',
    })
    expect(instance.current().limits.leaseSeconds).toBe(120)
  })

  it('a rule that sets no attempts follows the default as it changes', async () => {
    const { app, flow } = await setup()
    const rule = {
      id: 'split',
      watch: 'ready-to-split',
      agent: 'fake',
      mode: 'split',
      outcomes: { succeeded: 'split-review' },
    }
    const saved = await app.request('/api/flow', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow: { ...DEFAULT_FLOW, rules: [rule] } }),
    })
    expect(saved.status).toBe(200)
    expect(flow.current().rules[0]?.maxAttempts).toBe(3)
    await put(app, undefined, { limits: { defaultMaxAttempts: 5 } })
    expect(flow.current().rules[0]?.maxAttempts).toBe(5)
    expect(flow.context.defaultMaxAttempts).toBe(5)
  })
})
