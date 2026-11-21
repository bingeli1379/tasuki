import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createStatusMap,
  isRunnable,
  ITEM_STATUS_DISPLAY,
  TASK_STATUS_DISPLAY,
  type Rule,
  type RunExit,
  type RunnerPort,
  type RunSpec,
  type TaskNode,
  type WorkUnit,
} from '@tasuki/core'
import { createSqliteTracker, migrate as migrateTracker, TRACKER_MIGRATIONS } from '@tasuki/sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { createApp } from './app'
import { createEngine } from './engine'
import { createRunTokens } from './run-tokens'
import { openDatabase } from './runtime-store/database'
import { migrate } from './runtime-store/migrate'
import { RUNTIME_MIGRATIONS } from './runtime-store/migrations'
import { createRuntimeStore } from './runtime-store/run-store'

const statuses = createStatusMap({ item: ITEM_STATUS_DISPLAY, task: TASK_STATUS_DISPLAY })

const split: Rule = {
  id: 'split',
  watch: 'ready-to-split',
  claim: 'splitting',
  agent: 'fake',
  mode: 'split',
  maxAttempts: 2,
  on: { succeeded: 'split-review', needs_input: 'needs-answers' },
}

// Rule B: no claim status, the lease alone keeps a second Run off the item.
const execute: Rule = {
  id: 'execute',
  watch: 'in-progress',
  agent: 'fake',
  mode: 'execute',
  maxAttempts: 2,
  on: { succeeded: 'in-review', needs_input: 'blocked', blocked_manual: 'blocked' },
}

// Rule C: same claim status as split, and its new tasks go through split-review too.
const rework: Rule = {
  id: 'rework',
  watch: 'ready-to-rework',
  claim: 'splitting',
  agent: 'fake',
  mode: 'rework',
  maxAttempts: 2,
  on: { succeeded: 'split-review', needs_input: 'blocked' },
}

// What a scripted agent does once started: it gets an MCP client already connected to the
// facade with its Run's token, and returns how its process exits.
type Script = (mcp: Client, spec: RunSpec) => Promise<RunExit>

const ok: RunExit = { code: 0, signal: null }
const report =
  (verdict: string): Script =>
  async (mcp) => {
    await mcp.callTool({
      name: 'report_result',
      arguments: { verdict, summary: `said ${verdict}` },
    })
    return ok
  }
const hang: Script = () => new Promise(() => {})
const text = (res: Awaited<ReturnType<Client['callTool']>>): string =>
  (res.content as { text: string }[])[0]?.text ?? ''
// What a splitter that did its job does: tasks first, each waiting for the one before.
const splitInto =
  (...titles: string[]): Script =>
  async (mcp, spec) => {
    let previous: string | undefined
    for (const title of titles.length > 0 ? titles : ['Schema', 'Endpoint']) {
      const res = await mcp.callTool({
        name: 'create_task',
        arguments: { title, blockedBy: previous === undefined ? [] : [previous] },
      })
      previous = (JSON.parse(text(res)) as WorkUnit).ref
    }
    return report('succeeded')(mcp, spec)
  }
const move = async (mcp: Client, task: string, status: string): Promise<boolean> =>
  (
    await mcp.callTool({
      name: 'set_task_status',
      arguments: { task, status, reason: `To ${status}.` },
    })
  ).isError !== true
// What an executor that did its job does: every task it can run, in order, to done.
const walk: Script = async (mcp, spec) => {
  for (;;) {
    const tasks = JSON.parse(
      text(await mcp.callTool({ name: 'list_tasks', arguments: {} })),
    ) as TaskNode[]
    const next = tasks.find((t) => isRunnable(t, tasks))
    if (next === undefined) break
    for (const status of ['in-progress', 'in-review', 'done']) await move(mcp, next.ref, status)
  }
  return report('succeeded')(mcp, spec)
}
const ask: Script = async (mcp, spec) => {
  await mcp.callTool({
    name: 'add_comment',
    arguments: { kind: 'question', body: 'Which login provider?' },
  })
  return report('needs_input')(mcp, spec)
}

// The real sqlite tracker and runtime store, a clock the test moves, and the app serving
// the facade, so a scripted agent goes through the same HTTP path as the fake runner.
function setup(
  runtimeDb = openDatabase(':memory:'),
  trackerDb = openDatabase(':memory:'),
  now = { t: Date.parse('2026-11-20T12:00:00Z') },
) {
  migrate(runtimeDb, RUNTIME_MIGRATIONS)
  migrateTracker(trackerDb, TRACKER_MIGRATIONS)
  const clock = { now: () => new Date(now.t) }
  const storage = createSqliteTracker({ clock, dataDir: '', statuses }, trackerDb, 'T')
  const runtime = createRuntimeStore(runtimeDb, clock, '/logs')
  const tokens = createRunTokens()
  const app = createApp({
    db: runtimeDb,
    storage,
    runtime,
    statuses,
    rules: [split, execute, rework],
    holdLabel: 'hold',
    tokens,
  })
  const scripts: Script[] = []
  const started: RunSpec[] = []
  // The signals each agent got, in order; with ignoreSigterm an agent outlives SIGTERM.
  const signals: string[] = []
  const agent = { ignoreSigterm: false }
  const runner: RunnerPort = {
    start(spec) {
      started.push(spec)
      const script = scripts.shift() ?? splitInto()
      let killed: (exit: RunExit) => void = () => {}
      const dead = new Promise<RunExit>((resolve) => (killed = resolve))
      const alive = (async () => {
        const mcp = new Client({ name: 'agent', version: '0' })
        await mcp.connect(
          new StreamableHTTPClientTransport(new URL(spec.mcp.url), {
            fetch: (url, init) => Promise.resolve(app.request(String(url), init)),
            requestInit: { headers: { Authorization: `Bearer ${spec.mcp.token}` } },
          }),
        )
        return script(mcp, spec)
      })()
      return {
        exit: Promise.race([alive, dead]),
        terminate(signal) {
          signals.push(signal)
          if (signal === 'SIGKILL' || !agent.ignoreSigterm) killed({ code: null, signal })
        },
      }
    },
  }
  const logs: string[] = []
  const engine = (rules: Rule[] = [split], maxConcurrentRuns = 2) =>
    createEngine({
      storage,
      runtime,
      clock,
      rules,
      limits: {
        maxConcurrentRuns,
        leaseSeconds: 120,
        defaultMaxAttempts: 3,
        softGraceSeconds: 300,
        hardGraceSeconds: 10,
      },
      holdLabel: 'hold',
      workspaceRoot: mkdtempSync(join(tmpdir(), 'tasuki-ws-')),
      runners: { fake: runner },
      tokens,
      mcpUrl: 'http://localhost/agent-mcp',
      log: (m) => logs.push(m),
    })
  const readyItem = async (title = 'Login page'): Promise<WorkUnit> => {
    const item = await storage.createItem({ title, body: '', status: 'refining' })
    return storage.transition(item.ref, 'refining', 'ready-to-split')
  }
  // Approved in split-review: in-progress with the given tasks, each waiting for the one
  // before unless it is manual.
  const approvedItem = async (...tasks: [string, string][]): Promise<WorkUnit[]> => {
    const item = await storage.createItem({ title: 'Login page', body: '', status: 'in-progress' })
    const made: WorkUnit[] = [item]
    for (const [title, status] of tasks.length > 0
      ? tasks
      : ([
          ['Schema', 'to-do'],
          ['Endpoint', 'to-do'],
        ] as [string, string][])) {
      const previous = made.at(-1)
      made.push(
        await storage.createTask(item.ref, {
          title,
          body: '',
          status,
          origin: 'splitter',
          blockedBy: made.length > 1 && previous !== undefined ? [previous.ref] : [],
        }),
      )
    }
    return made
  }
  return {
    storage,
    runtime,
    app,
    approvedItem,
    scripts,
    started,
    signals,
    agent,
    engine,
    readyItem,
    now,
    logs,
    runtimeDb,
    trackerDb,
  }
}

describe('rule split on a fake agent', () => {
  it('claims a ready item into splitting while the agent works, and shows the Run', async () => {
    const t = setup()
    t.scripts.push(hang)
    const item = await t.readyItem()
    await t.engine().tick()

    expect((await t.storage.get(item.ref)).status).toBe('splitting')
    const [run] = await t.runtime.runsFor(item.ref)
    expect(run).toMatchObject({ rule: 'split', attempt: 1, state: 'running' })
    expect(t.started).toMatchObject([{ target: item.ref, mode: 'split' }])
    const board = (await (await t.app.request('/api/board')).json()) as { running: string[] }
    expect(board.running).toEqual([item.ref])
  })

  it.each([
    ['succeeded', 'split-review', splitInto()],
    ['needs_input', 'needs-answers', ask],
    ['failed', 'blocked', report('failed')],
  ])(
    'moves the item on the reported %s and says so in a system comment',
    async (verdict, to, script) => {
      const t = setup()
      t.scripts.push(script)
      const item = await t.readyItem()
      const engine = t.engine()
      await engine.tick()
      await engine.settled()

      expect((await t.storage.get(item.ref)).status).toBe(to)
      expect((await t.runtime.runsFor(item.ref))[0]).toMatchObject({
        state: 'finished',
        outcome: verdict,
        verdict,
        summary: `said ${verdict}`,
      })
      const comment = (await t.storage.comments(item.ref)).find((c) => c.author === 'engine')
      expect(comment).toMatchObject({ kind: 'system' })
      expect(comment?.body).toBe(
        `Rule split, attempt 1: ${verdict}, moved to ${to}.\n\nsaid ${verdict}`,
      )
    },
  )

  it('is failed when the agent exits without a verdict, or with a non-zero code', async () => {
    const t = setup()
    t.scripts.push(
      () => Promise.resolve(ok),
      async (mcp) => {
        await report('succeeded')(mcp, t.started[1] as RunSpec)
        return { code: 3, signal: null }
      },
    )
    const silent = await t.readyItem('silent')
    const crashed = await t.readyItem('crashed')
    const engine = t.engine()
    await engine.tick()
    await engine.settled()

    for (const [item, why] of [
      [silent, 'the agent reported no verdict'],
      [crashed, 'exit code 3'],
    ] as const) {
      expect((await t.storage.get(item.ref)).status).toBe('blocked')
      expect((await t.runtime.runsFor(item.ref))[0]?.outcome).toBe('failed')
      expect((await t.storage.comments(item.ref))[0]?.body).toContain(`Why: ${why}.`)
    }
  })

  // agent-contract.md, the verdict table.
  it.each([
    ['succeeded', report('succeeded'), 'the agent reported succeeded but the item has no tasks'],
    ['needs_input', report('needs_input'), 'the agent reported needs_input but asked no question'],
  ])('does not take %s from an agent that did not do it: failed', async (_verdict, script, why) => {
    const t = setup()
    t.scripts.push(script)
    const item = await t.readyItem()
    const engine = t.engine()
    await engine.tick()
    await engine.settled()

    expect((await t.storage.get(item.ref)).status).toBe('blocked')
    expect((await t.runtime.runsFor(item.ref))[0]?.outcome).toBe('failed')
    expect((await t.storage.comments(item.ref))[0]?.body).toContain(`Why: ${why}.`)
  })

  it('a split counts tasks an earlier run left on the item (D30)', async () => {
    const t = setup()
    const item = await t.readyItem()
    await t.storage.createTask(item.ref, {
      title: 'from refine',
      body: '',
      status: 'manual',
      origin: 'refine',
      blockedBy: [],
    })
    t.scripts.push(report('succeeded'))
    const engine = t.engine()
    await engine.tick()
    await engine.settled()
    expect((await t.storage.get(item.ref)).status).toBe('split-review')
  })

  it('a split agent saying blocked_manual has nowhere to go, so it is failed', async () => {
    const t = setup()
    t.scripts.push(report('blocked_manual'))
    const item = await t.readyItem()
    const engine = t.engine()
    await engine.tick()
    await engine.settled()

    expect((await t.storage.get(item.ref)).status).toBe('blocked')
    expect((await t.runtime.runsFor(item.ref))[0]?.outcome).toBe('failed')
  })

  it('a person moving the item while the agent works wins: cancelled, no status written (invariant 6)', async () => {
    const t = setup()
    let release = (): void => {}
    const moved = new Promise<void>((r) => (release = r))
    t.scripts.push(async (mcp) => {
      await moved
      return report('succeeded')(mcp, t.started[0] as RunSpec)
    })
    const item = await t.readyItem()
    const engine = t.engine()
    await engine.tick()
    await t.storage.transition(item.ref, 'splitting', 'refining')
    release()
    await engine.settled()

    expect((await t.storage.get(item.ref)).status).toBe('refining')
    expect((await t.runtime.runsFor(item.ref))[0]?.outcome).toBe('cancelled')
    expect(await t.storage.comments(item.ref)).toEqual([])
  })

  it('never runs two agents on one item at once (invariant 1)', async () => {
    const t = setup()
    t.scripts.push(hang)
    const item = await t.readyItem()
    const engine = t.engine()
    await engine.tick()
    // Back in the watch status while its Run is still alive, e.g. a person dragged it back.
    await t.storage.transition(item.ref, 'splitting', 'ready-to-split')
    await engine.tick()

    expect(t.started).toHaveLength(1)
    expect(await t.runtime.liveRuns()).toHaveLength(1)
  })

  it('starts no more agents than maxConcurrentRuns; the rest wait for the next round', async () => {
    const t = setup()
    t.scripts.push(hang, hang)
    await t.readyItem('a')
    await t.readyItem('b')
    const engine = t.engine([split], 1)
    await engine.tick()
    await engine.tick()

    expect(t.started.map((s) => s.target)).toEqual(['T-1'])
    expect((await t.storage.get('T-2')).status).toBe('ready-to-split')
  })
})

describe('rule execute on a fake agent', () => {
  it('runs the tasks to done, moves the item to in-review, and leaves a reason on each move', async () => {
    const t = setup()
    t.scripts.push(walk)
    const [item, schema] = await t.approvedItem()
    const engine = t.engine([execute])
    await engine.tick()
    await engine.settled()

    expect(t.started).toMatchObject([{ target: item?.ref, mode: 'execute' }])
    expect((await t.storage.get(item?.ref ?? '')).status).toBe('in-review')
    expect((await t.storage.children(item?.ref ?? '')).map((x) => x.status)).toEqual([
      'done',
      'done',
    ])
    expect(
      (await t.storage.comments(schema?.ref ?? '')).map((c) => [c.author, c.kind, c.body]),
    ).toEqual([
      ['engine', 'system', 'The agent moved it from to-do to in-progress.\n\nTo in-progress.'],
      ['engine', 'system', 'The agent moved it from in-progress to in-review.\n\nTo in-review.'],
      ['engine', 'system', 'The agent moved it from in-review to done.\n\nTo done.'],
    ])
    expect((await t.storage.comments(item?.ref ?? ''))[0]?.body).toBe(
      'Rule execute, attempt 1: succeeded, moved to in-review.\n\nsaid succeeded',
    )
  })

  it('does not take succeeded while tasks are left: failed, to blocked', async () => {
    const t = setup()
    t.scripts.push(report('succeeded'))
    const [item] = await t.approvedItem()
    const engine = t.engine([execute])
    await engine.tick()
    await engine.settled()

    expect((await t.storage.get(item?.ref ?? '')).status).toBe('blocked')
    expect((await t.storage.comments(item?.ref ?? ''))[0]?.body).toContain(
      'Why: the agent reported succeeded but 2 of 2 tasks are not done.',
    )
  })

  it('takes blocked_manual once only manual work holds the item up', async () => {
    const t = setup()
    // Does the one task it can, then the manual one holds up the rest.
    t.scripts.push(async (mcp, spec) => {
      const tasks = JSON.parse(
        text(await mcp.callTool({ name: 'list_tasks', arguments: {} })),
      ) as TaskNode[]
      for (const status of ['in-progress', 'in-review', 'done'])
        await move(mcp, tasks[0]?.ref ?? '', status)
      return report('blocked_manual')(mcp, spec)
    })
    const [item] = await t.approvedItem(['Schema', 'to-do'], ['Sign the contract', 'manual'])
    const engine = t.engine([execute])
    await engine.tick()
    await engine.settled()

    expect((await t.storage.get(item?.ref ?? '')).status).toBe('blocked')
    expect((await t.runtime.runsFor(item?.ref ?? ''))[0]?.outcome).toBe('blocked_manual')
  })

  it('does not take blocked_manual while a task can still run: failed', async () => {
    const t = setup()
    t.scripts.push(report('blocked_manual'))
    const [item, schema] = await t.approvedItem(['Schema', 'to-do'], ['Sign', 'manual'])
    const engine = t.engine([execute])
    await engine.tick()
    await engine.settled()

    expect((await t.runtime.runsFor(item?.ref ?? ''))[0]?.outcome).toBe('failed')
    expect((await t.storage.comments(item?.ref ?? ''))[0]?.body).toContain(
      `Why: the agent reported blocked_manual but ${schema?.ref} can still run.`,
    )
  })

  it('sends a task left in-progress back to to-do once the Run is over (invariant 3)', async () => {
    const t = setup()
    t.scripts.push(async (mcp, spec) => {
      const tasks = JSON.parse(
        text(await mcp.callTool({ name: 'list_tasks', arguments: {} })),
      ) as TaskNode[]
      await move(mcp, tasks[0]?.ref ?? '', 'in-progress')
      return report('failed')(mcp, spec)
    })
    const [item, schema] = await t.approvedItem()
    const engine = t.engine([execute])
    await engine.tick()
    await engine.settled()

    expect((await t.storage.get(item?.ref ?? '')).status).toBe('blocked')
    expect((await t.storage.get(schema?.ref ?? '')).status).toBe('to-do')
    expect((await t.storage.comments(schema?.ref ?? '')).at(-1)?.body).toBe(
      "Moved back to to-do: rule execute's run ended failed.",
    )
  })

  it('leaves tasks alone when a person took the item over (invariant 6)', async () => {
    const t = setup()
    let release = (): void => {}
    const moved = new Promise<void>((r) => (release = r))
    t.scripts.push(async (mcp, spec) => {
      const tasks = JSON.parse(
        text(await mcp.callTool({ name: 'list_tasks', arguments: {} })),
      ) as TaskNode[]
      await move(mcp, tasks[0]?.ref ?? '', 'in-progress')
      await moved
      return report('succeeded')(mcp, spec)
    })
    const [item, schema] = await t.approvedItem()
    const engine = t.engine([execute])
    await engine.tick()
    // Give the agent its first move before the person steps in.
    while ((await t.storage.get(schema?.ref ?? '')).status !== 'in-progress')
      await new Promise((r) => setTimeout(r, 5))
    await t.storage.transition(item?.ref ?? '', 'in-progress', 'refining')
    release()
    await engine.settled()

    expect((await t.runtime.runsFor(item?.ref ?? ''))[0]?.outcome).toBe('cancelled')
    expect((await t.storage.get(schema?.ref ?? '')).status).toBe('in-progress')
  })

  it('refuses moves off the task diagram, and a blank reason', async () => {
    const t = setup()
    const refused: boolean[] = []
    t.scripts.push(async (mcp, spec) => {
      const tasks = JSON.parse(
        text(await mcp.callTool({ name: 'list_tasks', arguments: {} })),
      ) as TaskNode[]
      const [schema, sign, endpoint] = tasks.map((x) => x.ref)
      refused.push(
        !(await move(mcp, endpoint ?? '', 'in-progress')), // waits for sign
        !(await move(mcp, sign ?? '', 'to-do')), // manual: a person's
        !(await move(mcp, schema ?? '', 'done')), // skips in-progress and in-review
        (
          await mcp.callTool({
            name: 'set_task_status',
            arguments: { task: schema, status: 'in-progress', reason: ' ' },
          })
        ).isError === true,
      )
      return report('failed')(mcp, spec)
    })
    const [item] = await t.approvedItem(
      ['Schema', 'to-do'],
      ['Sign', 'manual'],
      ['Endpoint', 'to-do'],
    )
    const engine = t.engine([execute])
    await engine.tick()
    await engine.settled()

    expect(refused).toEqual([true, true, true, true])
    expect((await t.storage.children(item?.ref ?? '')).map((x) => x.status)).toEqual([
      'to-do',
      'manual',
      'to-do',
    ])
  })

  it('gives an executor set_task_status and no create_task (agent-contract.md)', async () => {
    const t = setup()
    let names: string[] = []
    t.scripts.push(async (client, spec) => {
      names = (await client.listTools()).tools.map((tool) => tool.name)
      return report('failed')(client, spec)
    })
    await t.approvedItem()
    const engine = t.engine([execute])
    await engine.tick()
    await engine.settled()
    expect(names).toEqual([
      'get_item',
      'list_tasks',
      'list_comments',
      'add_comment',
      'set_task_status',
      'report_result',
    ])
  })

  it('after a lease expiry the item stays in-progress, its tasks go back, and attempt 2 runs', async () => {
    const first = setup()
    first.scripts.push(async (mcp) => {
      const tasks = JSON.parse(
        text(await mcp.callTool({ name: 'list_tasks', arguments: {} })),
      ) as TaskNode[]
      await move(mcp, tasks[0]?.ref ?? '', 'in-progress')
      return hang(mcp, first.started[0] as RunSpec)
    })
    const [item, schema] = await first.approvedItem()
    await first.engine([execute]).tick()
    while ((await first.storage.get(schema?.ref ?? '')).status !== 'in-progress')
      await new Promise((r) => setTimeout(r, 5))

    const second = setup(first.runtimeDb, first.trackerDb, first.now)
    second.scripts.push(hang)
    second.now.t += 121_000
    await second.engine([execute]).tick()

    expect((await second.storage.get(item?.ref ?? '')).status).toBe('in-progress')
    expect((await second.storage.get(schema?.ref ?? '')).status).toBe('to-do')
    expect(
      (await second.runtime.runsFor(item?.ref ?? '')).map((r) => [r.attempt, r.outcome]),
    ).toEqual([
      [2, undefined],
      [1, 'abandoned'],
    ])
    expect((await second.storage.comments(item?.ref ?? ''))[0]?.body).toBe(
      'Rule execute, attempt 1: the agent stopped answering. The next round tries again.',
    )
  })

  it('gives up on a Run whose item was deleted, and keeps claiming the rest', async () => {
    const first = setup()
    first.scripts.push(hang)
    const [item] = await first.approvedItem()
    await first.engine([execute]).tick()
    const other = await first.readyItem('other')
    // There is no delete in StoragePort; a person deletes the issue in Jira.
    first.trackerDb.exec('PRAGMA foreign_keys = OFF')
    first.trackerDb
      .prepare('DELETE FROM work_unit WHERE ref = ? OR parent = ?')
      .run(item?.ref ?? '', item?.ref ?? '')

    const second = setup(first.runtimeDb, first.trackerDb, first.now)
    second.scripts.push(hang)
    second.now.t += 121_000
    await second.engine([split, execute]).tick()

    expect(second.logs).toEqual([])
    expect((await second.runtime.runsFor(item?.ref ?? ''))[0]?.outcome).toBe('abandoned')
    expect((await second.storage.get(other.ref)).status).toBe('splitting')
  })
})

describe('auto-resume (state-machine.md)', () => {
  // Executes what it can, then stops at the manual task.
  const stopAtManual: Script = async (mcp, spec) => {
    const tasks = JSON.parse(
      text(await mcp.callTool({ name: 'list_tasks', arguments: {} })),
    ) as TaskNode[]
    for (const status of ['in-progress', 'in-review', 'done'])
      await move(mcp, tasks[0]?.ref ?? '', status)
    return report('blocked_manual')(mcp, spec)
  }

  it('picks a blocked item up again once a person has done its manual task', async () => {
    const t = setup()
    t.scripts.push(stopAtManual, walk)
    const [item, , manual] = await t.approvedItem(
      ['Schema', 'to-do'],
      ['Sign the contract', 'manual'],
      ['Endpoint', 'to-do'],
    )
    const ref = item?.ref ?? ''
    const engine = t.engine([execute])
    await engine.tick()
    await engine.settled()
    expect((await t.storage.get(ref)).status).toBe('blocked')

    // Still manual: the next round leaves it.
    await engine.tick()
    await engine.settled()
    expect(t.started).toHaveLength(1)

    await t.storage.transition(manual?.ref ?? '', 'manual', 'done')
    await engine.tick()
    await engine.settled()
    expect(t.started).toHaveLength(2)
    expect((await t.storage.get(ref)).status).toBe('in-review')
    expect((await t.runtime.runsFor(ref)).map((r) => [r.attempt, r.outcome])).toEqual([
      [1, 'succeeded'],
      [1, 'blocked_manual'],
    ])
    expect((await t.storage.comments(ref)).map((c) => c.body)).toContain(
      'No task is manual any more. Moved back to in-progress for rule execute to carry on.',
    )
  })

  it('leaves an item blocked for another reason where it is', async () => {
    const t = setup()
    t.scripts.push(ask)
    const [item] = await t.approvedItem()
    const engine = t.engine([execute])
    await engine.tick()
    await engine.settled()
    await engine.tick()
    await engine.settled()
    expect((await t.storage.get(item?.ref ?? '')).status).toBe('blocked')
    expect(t.started).toHaveLength(1)
  })
})

describe('rule rework on a fake agent', () => {
  // Finished work a person did not accept: every task done, the item in in-review.
  const reviewedItem = async (t: ReturnType<typeof setup>): Promise<WorkUnit> => {
    const [item, ...tasks] = await t.approvedItem(['Schema', 'done'])
    for (const task of tasks) expect(task.status).toBe('done')
    return t.storage.transition(item?.ref ?? '', 'in-progress', 'in-review')
  }
  const send = (t: ReturnType<typeof setup>, ref: string, feedback: string) =>
    t.app.request(`/api/items/${ref}/rework`, {
      method: 'POST',
      body: JSON.stringify({ from: 'in-review', feedback }),
    })

  it("makes new tasks from the person's feedback and sends them to split-review", async () => {
    const t = setup()
    let feedback = ''
    t.scripts.push(async (mcp, spec) => {
      const comments = JSON.parse(
        text(await mcp.callTool({ name: 'list_comments', arguments: {} })),
      ) as { author: string; kind: string; body: string }[]
      feedback = comments.findLast((c) => c.author === 'human' && c.kind === 'note')?.body ?? ''
      await mcp.callTool({ name: 'create_task', arguments: { title: 'Fix it', body: feedback } })
      return report('succeeded')(mcp, spec)
    })
    const item = await reviewedItem(t)
    expect((await send(t, item.ref, 'The button is the wrong colour.')).status).toBe(200)
    expect((await t.storage.get(item.ref)).status).toBe('ready-to-rework')

    const engine = t.engine([rework])
    await engine.tick()
    await engine.settled()
    expect(feedback).toBe('The button is the wrong colour.')
    expect((await t.storage.get(item.ref)).status).toBe('split-review')
    // The done task stays done; the fix is a new task (invariant 4).
    expect((await t.storage.children(item.ref)).map((c) => [c.title, c.status])).toEqual([
      ['Schema', 'done'],
      ['Fix it', 'to-do'],
    ])
  })

  it('is failed when it made no task in this run, even with tasks on the item', async () => {
    const t = setup()
    t.scripts.push(report('succeeded'))
    const item = await reviewedItem(t)
    await send(t, item.ref, 'Wrong.')
    const engine = t.engine([rework])
    await engine.tick()
    await engine.settled()
    expect((await t.storage.get(item.ref)).status).toBe('blocked')
  })

  it('moved there in the tracker with no word on what to fix, it waits in blocked for one', async () => {
    const t = setup()
    const item = await reviewedItem(t)
    await t.storage.transition(item.ref, 'in-review', 'ready-to-rework')
    const engine = t.engine([rework])
    await engine.tick()
    expect(t.started).toHaveLength(0)
    expect((await t.storage.get(item.ref)).status).toBe('blocked')
    expect((await t.storage.comments(item.ref)).at(-1)?.body).toBe(
      'Rule rework needs a comment saying what to rework, and none was left since the last run. Moved to blocked: write one, then move it back to ready-to-rework.',
    )

    // A note written straight in the tracker is feedback too.
    t.scripts.push(splitInto('Fix it'))
    await t.storage.addComment({
      target: item.ref,
      author: 'human',
      kind: 'note',
      body: 'Fix the colour.',
    })
    await t.storage.transition(item.ref, 'blocked', 'ready-to-rework')
    await engine.tick()
    await engine.settled()
    expect(t.started).toHaveLength(1)
    expect((await t.storage.get(item.ref)).status).toBe('split-review')
  })

  it('a send-back without feedback is a 400 and the item stays', async () => {
    const t = setup()
    const item = await reviewedItem(t)
    const res = await send(t, item.ref, ' ')
    expect(res.status).toBe(400)
    expect((await t.storage.get(item.ref)).status).toBe('in-review')
  })
})

describe('lease expiry (stop-and-recovery.md, D38)', () => {
  // The engine process dies mid-Run: a new one on the same databases finds a Run nobody
  // renews any more.
  const restart = (t: ReturnType<typeof setup>): ReturnType<typeof setup> =>
    setup(t.runtimeDb, t.trackerDb, t.now)

  it('sends the item back to ready-to-split, and the next round runs attempt 2', async () => {
    const first = setup()
    first.scripts.push(hang)
    const item = await first.readyItem()
    await first.engine().tick()

    const second = restart(first)
    second.scripts.push(hang)
    second.now.t += 60_000
    await second.engine().tick()
    expect((await second.runtime.runsFor(item.ref))[0]?.state).toBe('running')

    second.now.t += 61_000
    await second.engine().tick()
    const runs = await second.runtime.runsFor(item.ref)
    expect(runs.map((r) => [r.attempt, r.state, r.outcome])).toEqual([
      [2, 'running', undefined],
      [1, 'finished', 'abandoned'],
    ])
    expect((await second.storage.get(item.ref)).status).toBe('splitting')
    expect((await second.storage.comments(item.ref))[0]?.body).toBe(
      'Rule split, attempt 1: the agent stopped answering. Moved back to ready-to-split to try again.',
    )
  })

  it('past maxAttempts it goes to blocked; pulled back by a person it starts over at 1', async () => {
    let t = setup()
    t.scripts.push(hang)
    const item = await t.readyItem()
    await t.engine().tick()
    // maxAttempts is 2: two Runs die, and the round after the second gives up.
    t = restart(t)
    t.scripts.push(hang)
    t.now.t += 121_000
    await t.engine().tick()
    t = restart(t)
    t.now.t += 121_000
    await t.engine().tick()

    expect((await t.storage.get(item.ref)).status).toBe('blocked')
    const runs = await t.runtime.runsFor(item.ref)
    expect(runs.map((r) => [r.attempt, r.outcome])).toEqual([
      [3, 'max_attempts'],
      [2, 'abandoned'],
      [1, 'abandoned'],
    ])
    expect((await t.storage.comments(item.ref)).at(-1)?.body).toBe(
      'Rule split gave up after 2 attempts that never finished. Moved to blocked.',
    )

    await t.storage.transition(item.ref, 'blocked', 'ready-to-split')
    t.scripts.push(splitInto())
    const engine = t.engine()
    await engine.tick()
    await engine.settled()
    expect((await t.runtime.runsFor(item.ref))[0]).toMatchObject({
      attempt: 1,
      outcome: 'succeeded',
    })
    expect((await t.storage.get(item.ref)).status).toBe('split-review')
  })

  it('leaves an item a person already moved out of the claim status where it is', async () => {
    const first = setup()
    first.scripts.push(hang)
    const item = await first.readyItem()
    await first.engine().tick()
    await first.storage.transition(item.ref, 'splitting', 'refining')

    const second = restart(first)
    second.now.t += 121_000
    await second.engine().tick()
    expect((await second.storage.get(item.ref)).status).toBe('refining')
    expect((await second.runtime.runsFor(item.ref))[0]?.outcome).toBe('abandoned')
  })
})

describe('stopping a run (stop-and-recovery.md)', () => {
  const stop = (t: ReturnType<typeof setup>, ref: string) =>
    t.app.request(`/api/items/${ref}/stop`, { method: 'POST' })
  const hold = (t: ReturnType<typeof setup>, ref: string, method: 'PUT' | 'DELETE') =>
    t.app.request(`/api/items/${ref}/hold`, { method })
  // Waits for the go, tries to write, reports, then never exits on its own.
  const lateWriter = () => {
    let go: () => void = () => {}
    let wrote: (refusal: string) => void = () => {}
    const gate = new Promise<void>((resolve) => (go = resolve))
    const refusal = new Promise<string>((resolve) => (wrote = resolve))
    const script: Script = async (mcp, spec) => {
      await gate
      const res = await mcp.callTool({ name: 'create_task', arguments: { title: 'Late' } })
      await report('succeeded')(mcp, spec)
      wrote(text(res))
      return hang(mcp, spec)
    }
    return { script, go, refusal }
  }

  it('Stop ends the agent, holds the item where it was, and releasing starts it over', async () => {
    const t = setup()
    t.scripts.push(hang)
    const item = await t.readyItem()
    const engine = t.engine()
    await engine.tick()
    expect((await stop(t, item.ref)).status).toBe(200)
    await engine.enforce()
    await engine.settled()

    expect(t.signals).toEqual(['SIGTERM'])
    expect((await t.runtime.runsFor(item.ref))[0]).toMatchObject({
      outcome: 'cancelled',
      cancelMode: 'hard',
      cancelRequestedBy: 'stop',
    })
    expect(await t.storage.get(item.ref)).toMatchObject({ status: 'splitting', labels: ['hold'] })
    expect((await t.storage.comments(item.ref)).at(-1)?.body).toBe(
      'Rule split, attempt 1: cancelled, a person pressed Stop. The engine moved nothing.',
    )
    await engine.tick()
    expect(t.started).toHaveLength(1)

    expect((await hold(t, item.ref, 'DELETE')).status).toBe(200)
    await engine.tick()
    await engine.settled()
    expect(t.started).toHaveLength(2)
    expect((await t.storage.get(item.ref)).status).toBe('split-review')
    expect((await t.runtime.runsFor(item.ref))[0]).toMatchObject({
      attempt: 1,
      outcome: 'succeeded',
    })
    expect((await t.storage.comments(item.ref)).map((c) => c.body)).toContain(
      'The hold is off. Moved back to ready-to-split for rule split to start again.',
    )
  })

  it('Stop after the round already saw its hold label still says Stop', async () => {
    const t = setup()
    t.scripts.push(hang)
    const item = await t.readyItem()
    const engine = t.engine()
    await engine.tick()
    // On Jira the label lands seconds before the hard cancel; a round can come in between.
    await t.storage.addLabel(item.ref, 'hold')
    await engine.tick()
    await stop(t, item.ref)
    await engine.enforce()
    await engine.settled()
    expect((await t.runtime.runsFor(item.ref))[0]).toMatchObject({
      cancelMode: 'hard',
      cancelRequestedBy: 'stop',
    })
    expect((await t.storage.comments(item.ref)).at(-1)?.body).toContain('a person pressed Stop')
  })

  it('Stop with no agent on the item is a 400 and puts nothing on hold', async () => {
    const t = setup()
    const item = await t.readyItem()
    expect((await stop(t, item.ref)).status).toBe(400)
    expect((await t.storage.get(item.ref)).labels).toEqual([])
  })

  it('an agent that ignores SIGTERM gets SIGKILL after hardGraceSeconds', async () => {
    const t = setup()
    t.scripts.push(hang)
    t.agent.ignoreSigterm = true
    const item = await t.readyItem()
    const engine = t.engine()
    await engine.tick()
    await stop(t, item.ref)
    await engine.enforce()
    t.now.t += 9_000
    await engine.enforce()
    expect(t.signals).toEqual(['SIGTERM'])
    t.now.t += 1_000
    await engine.enforce()
    await engine.settled()
    expect(t.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect((await t.runtime.runsFor(item.ref))[0]?.outcome).toBe('cancelled')
  })

  it("hold refuses the agent's writes and ignores its report; past softGraceSeconds it is ended", async () => {
    const t = setup()
    const agent = lateWriter()
    t.scripts.push(agent.script)
    const item = await t.readyItem()
    const engine = t.engine()
    await engine.tick()
    expect((await hold(t, item.ref, 'PUT')).status).toBe(200)
    agent.go()
    expect(await agent.refusal).toMatch(/^RUN_CANCELLED/)

    t.now.t += 299_000
    await engine.enforce()
    expect(t.signals).toEqual([])
    t.now.t += 1_000
    await engine.enforce()
    await engine.settled()
    expect(t.signals).toEqual(['SIGTERM'])
    const [run] = await t.runtime.runsFor(item.ref)
    expect(run).toMatchObject({
      outcome: 'cancelled',
      cancelMode: 'hard',
      cancelRequestedBy: 'hold',
    })
    expect(run?.verdict).toBeUndefined()
    expect(await t.storage.children(item.ref)).toEqual([])
    expect((await t.storage.get(item.ref)).status).toBe('splitting')
  })

  it('a hold set in the tracker by hand, or a person moving the item, is noticed by the round', async () => {
    const t = setup()
    t.scripts.push(hang, hang)
    const [held] = await t.approvedItem()
    const moved = await t.readyItem()
    const engine = t.engine([split, execute])
    await engine.tick()
    expect(t.started).toHaveLength(2)

    await t.storage.addLabel(held?.ref ?? '', 'hold')
    await t.storage.transition(moved.ref, 'splitting', 'refining')
    await engine.tick()
    expect(
      (await t.runtime.liveRuns())
        .map((r) => [r.target, r.cancelMode, r.cancelRequestedBy])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      [held?.ref, 'soft', 'hold'],
      [moved.ref, 'soft', 'moved'],
    ])
    expect(t.started).toHaveLength(2)

    t.now.t += 300_000
    await engine.enforce()
    await engine.settled()
    expect((await t.storage.comments(moved.ref)).at(-1)?.body).toBe(
      'Rule split, attempt 1: cancelled, the item was moved while it ran. The engine moved nothing.',
    )
    expect((await t.storage.get(moved.ref)).status).toBe('refining')
    expect((await t.storage.get(held?.ref ?? '')).status).toBe('in-progress')
  })

  it('leaves an item on hold alone until it is released', async () => {
    const t = setup()
    const item = await t.readyItem()
    await hold(t, item.ref, 'PUT')
    const engine = t.engine()
    await engine.tick()
    expect(t.started).toHaveLength(0)
    await hold(t, item.ref, 'DELETE')
    await engine.tick()
    await engine.settled()
    expect((await t.storage.get(item.ref)).status).toBe('split-review')
  })

  it('an item is deleted with its tasks, but not while an agent works on it', async () => {
    const t = setup()
    t.scripts.push(hang)
    const [item, task] = await t.approvedItem()
    const engine = t.engine([execute])
    await engine.tick()
    const del = () => t.app.request(`/api/items/${item?.ref}`, { method: 'DELETE' })
    expect((await del()).status).toBe(400)
    await stop(t, item?.ref ?? '')
    await engine.enforce()
    await engine.settled()
    expect((await del()).status).toBe(200)
    for (const ref of [item?.ref, task?.ref])
      expect((await t.app.request(`/api/items/${ref}`)).status).toBe(404)
  })

  it('only an item goes on hold', async () => {
    const t = setup()
    const [, task] = await t.approvedItem()
    expect((await hold(t, task?.ref ?? '', 'PUT')).status).toBe(400)
  })
})

describe('global pause (stop-and-recovery.md)', () => {
  const pause = (t: ReturnType<typeof setup>, kill = false) =>
    t.app.request('/api/engine/pause', { method: 'POST', body: JSON.stringify({ kill }) })
  const resume = (t: ReturnType<typeof setup>) =>
    t.app.request('/api/engine/resume', { method: 'POST' })

  it('starts no Run while paused, across a restart, and carries on once resumed', async () => {
    const t = setup()
    const item = await t.readyItem()
    expect((await pause(t)).status).toBe(200)
    await t.engine().tick()
    expect(t.started).toHaveLength(0)
    expect(await (await t.app.request('/api/board')).json()).toMatchObject({ paused: true })

    const again = setup(t.runtimeDb, t.trackerDb, t.now)
    const engine = again.engine()
    await engine.tick()
    expect(again.started).toHaveLength(0)
    expect((await resume(again)).status).toBe(200)
    await engine.tick()
    await engine.settled()
    expect((await again.storage.get(item.ref)).status).toBe('split-review')
  })

  it('lets a Run already working finish', async () => {
    const t = setup()
    let go: () => void = () => {}
    const gate = new Promise<void>((resolve) => (go = resolve))
    t.scripts.push(async (mcp, spec) => {
      await gate
      return splitInto()(mcp, spec)
    })
    const item = await t.readyItem()
    const engine = t.engine()
    await engine.tick()
    await pause(t)
    await engine.enforce()
    go()
    await engine.settled()
    expect(t.signals).toEqual([])
    expect((await t.storage.get(item.ref)).status).toBe('split-review')
  })

  it('with kill stops every Run; resumed, each item starts over where its rule starts', async () => {
    const t = setup()
    // Split is claimed before execute in each round.
    t.scripts.push(hang, hang, splitInto(), walk)
    const split1 = await t.readyItem()
    const [exec] = await t.approvedItem()
    const engine = t.engine([split, execute])
    await engine.tick()
    expect(t.started).toHaveLength(2)

    expect(await (await pause(t, true)).json()).toMatchObject({ stopped: expect.any(Array) })
    await engine.enforce()
    await engine.settled()
    expect(t.signals).toEqual(['SIGTERM', 'SIGTERM'])
    for (const ref of [split1.ref, exec?.ref ?? ''])
      expect((await t.runtime.runsFor(ref))[0]).toMatchObject({
        outcome: 'cancelled',
        cancelRequestedBy: 'pause',
      })

    // Still paused: the split item goes back to wait in ready-to-split, nothing starts.
    await engine.tick()
    expect(t.started).toHaveLength(2)
    expect((await t.storage.get(split1.ref)).status).toBe('ready-to-split')
    expect((await t.storage.get(exec?.ref ?? '')).status).toBe('in-progress')
    expect((await t.storage.comments(split1.ref)).at(-1)?.body).toBe(
      'Stopped by pausing the engine. Moved back to ready-to-split for rule split to start again.',
    )

    await resume(t)
    await engine.tick()
    await engine.settled()
    expect(t.started).toHaveLength(4)
    expect((await t.storage.get(split1.ref)).status).toBe('split-review')
    expect((await t.storage.get(exec?.ref ?? '')).status).toBe('in-review')
  })
})

describe('the MCP facade for agents', () => {
  it('reads only its own item, takes one report, and shuts the door once the Run is over', async () => {
    const t = setup()
    let mcp: Client | undefined
    t.scripts.push(async (client) => {
      mcp = client
      const read = await client.callTool({ name: 'get_item', arguments: {} })
      expect(JSON.parse(text(read))).toMatchObject({ ref: 'T-1', status: 'splitting' })
      await splitInto()(client, t.started[0] as RunSpec)
      const again = await client.callTool({
        name: 'report_result',
        arguments: { verdict: 'failed', summary: 'Changed my mind.' },
      })
      expect(again.isError).toBe(true)
      return ok
    })
    await t.readyItem()
    const engine = t.engine()
    await engine.tick()
    await engine.settled()

    expect((await t.runtime.runsFor('T-1'))[0]?.outcome).toBe('succeeded')
    await expect(mcp?.callTool({ name: 'get_item', arguments: {} })).rejects.toThrow()
  })

  it('makes tasks on its own item, shown with what each waits for, and counts them', async () => {
    const t = setup()
    t.scripts.push(splitInto('Schema', 'Endpoint', 'Page'))
    const item = await t.readyItem()
    const engine = t.engine()
    await engine.tick()
    await engine.settled()

    const detail = (await (await t.app.request(`/api/items/${item.ref}`)).json()) as {
      tasks: { ref: string; title: string; status: string; origin: string; blockedBy: string[] }[]
    }
    expect(detail.tasks.map((x) => [x.title, x.status, x.origin, x.blockedBy])).toEqual([
      ['Schema', 'to-do', 'splitter', []],
      ['Endpoint', 'to-do', 'splitter', [detail.tasks[0]?.ref]],
      ['Page', 'to-do', 'splitter', [detail.tasks[1]?.ref]],
    ])
    expect((await t.runtime.runsFor(item.ref))[0]?.produced).toEqual({ questions: 0, tasks: 3 })
    const board = (await (await t.app.request('/api/board')).json()) as {
      tasks: Record<string, unknown>
    }
    expect(board.tasks).toEqual({ [item.ref]: { done: 0, total: 3 } })
  })

  it('cannot reach another item: not its tasks, not its comments', async () => {
    const t = setup()
    const other = await t.storage.createItem({ title: 'other', body: '', status: 'refining' })
    const theirs = await t.storage.createTask(other.ref, {
      title: 'theirs',
      body: '',
      status: 'to-do',
      origin: 'human',
      blockedBy: [],
    })
    const errors: boolean[] = []
    t.scripts.push(async (mcp, spec) => {
      for (const call of [
        { name: 'create_task', arguments: { title: 'x', blockedBy: [theirs.ref] } },
        { name: 'add_comment', arguments: { target: other.ref, kind: 'note', body: 'hi' } },
        { name: 'list_comments', arguments: { target: theirs.ref } },
        { name: 'create_task', arguments: { title: 'x', initialStatus: 'done' } },
      ])
        errors.push((await mcp.callTool(call)).isError === true)
      return report('failed')(mcp, spec)
    })
    const item = await t.readyItem()
    const engine = t.engine()
    await engine.tick()
    await engine.settled()

    expect(errors).toEqual([true, true, true, true])
    expect(await t.storage.children(item.ref)).toEqual([])
    expect(await t.storage.comments(other.ref)).toEqual([])
  })

  it('has no tool that moves the item (invariant 2)', async () => {
    const t = setup()
    let names: string[] = []
    t.scripts.push(async (client) => {
      names = (await client.listTools()).tools.map((tool) => tool.name)
      return splitInto()(client, t.started[0] as RunSpec)
    })
    await t.readyItem()
    const engine = t.engine()
    await engine.tick()
    await engine.settled()
    expect(names).toEqual([
      'get_item',
      'list_tasks',
      'create_task',
      'list_comments',
      'add_comment',
      'report_result',
    ])
  })

  it('turns away a request without a live Run token', async () => {
    const res = await setup().app.request('/agent-mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })
})
