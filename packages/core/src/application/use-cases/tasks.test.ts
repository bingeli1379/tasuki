import { describe, expect, it } from 'vite-plus/test'
import type { Rule } from '../../domain/rule'
import type { Run } from '../../domain/run'
import type { WorkUnit } from '../../domain/work-unit'
import type { Station, Workflow } from '../../domain/workflow'
import { storeStub } from '../../testing/store-stub'
import { trackerStub } from '../../testing/tracker-stub'
import { InvalidInput } from '../invalid-input'
import { NotFound } from '../not-found'
import type { NewComment, NewTask } from '../ports/tracker'
import { addAgentComment } from './add-agent-comment'
import { createTask } from './create-task'
import { deleteTask, updateTask } from './edit-task'
import { getTask } from './get-task'
import { listBoard } from './list-board'
import { moveTask } from './move-task'

const run: Run = {
  id: 'r1',
  target: 'X-1',
  rule: 'split',
  agent: 'a',
  attempt: 1,
  workspace: '/w/X-1',
  state: 'running',
  produced: { questions: 0, tasks: 0 },
  leaseUntil: '',
  startedAt: '',
  lastActivityAt: '',
}

const workflow = (...stations: (Partial<Station> & { id: string })[]): Workflow => ({
  statuses: stations.map((s) => ({ name: s.id, outcomes: [], ...s })),
  roles: { entry: 'refining', failure: 'blocked' },
})

const unit = (ref: string, over: Partial<WorkUnit> = {}): WorkUnit => ({
  ref,
  kind: 'task',
  parent: 'X-1',
  title: ref,
  body: '',
  status: 'to-do',
  labels: [],
  origin: 'splitter',
  version: '1',
  ...over,
})

describe('createTask', () => {
  const recording = (): {
    deps: Parameters<typeof createTask>[0]
    tasks: NewTask[]
    bumped: string[]
  } => {
    const tasks: NewTask[] = []
    const bumped: string[] = []
    return {
      deps: {
        tracker: trackerStub({
          createTask: (_item, task) => (tasks.push(task), Promise.resolve(unit('X-2'))),
        }),
        store: storeStub({ bumpProduced: (_id, key) => (bumped.push(key), Promise.resolve()) }),
      },
      tasks,
      bumped,
    }
  }

  it('creates a splitter task under the Run item and counts it on the Run', async () => {
    const { deps, tasks, bumped } = recording()
    await createTask(deps, run, { title: ' Write it ', body: 'b', status: 'to-do', blockedBy: [] })
    expect(tasks).toEqual([
      { title: 'Write it', body: 'b', status: 'to-do', origin: 'splitter', blockedBy: [] },
    ])
    expect(bumped).toEqual(['tasks'])
  })

  it.each(['in-progress', 'done', 'refining'])('refuses to start a task in %s', async (status) => {
    const { deps, tasks } = recording()
    await expect(
      createTask(deps, run, { title: 't', body: '', status, blockedBy: [] }),
    ).rejects.toBeInstanceOf(InvalidInput)
    expect(tasks).toEqual([])
  })

  it('refuses a blank title', async () => {
    const { deps } = recording()
    await expect(
      createTask(deps, run, { title: ' ', body: '', status: 'to-do', blockedBy: [] }),
    ).rejects.toThrow('title is empty')
  })
})

describe('addAgentComment', () => {
  const recording = (): {
    deps: Parameters<typeof addAgentComment>[0]
    comments: NewComment[]
    bumped: string[]
  } => {
    const comments: NewComment[] = []
    const bumped: string[] = []
    return {
      deps: {
        tracker: trackerStub({
          children: () => Promise.resolve([unit('X-2')]),
          addComment: (c) => (comments.push(c), Promise.resolve({ id: '1', ...c, createdAt: '' })),
        }),
        store: storeStub({ bumpProduced: (_id, key) => (bumped.push(key), Promise.resolve()) }),
      },
      comments,
      bumped,
    }
  }

  it('writes as the agent, and counts a question for the needs_input check', async () => {
    const { deps, comments, bumped } = recording()
    await addAgentComment(deps, run, { target: 'X-1', kind: 'question', body: 'Which DB?' })
    await addAgentComment(deps, run, { target: 'X-2', kind: 'note', body: 'started' })
    expect(comments.map((c) => [c.target, c.author, c.kind])).toEqual([
      ['X-1', 'agent', 'question'],
      ['X-2', 'agent', 'note'],
    ])
    expect(bumped).toEqual(['questions'])
  })

  it('stays inside its own item', async () => {
    const { deps, comments } = recording()
    await expect(
      addAgentComment(deps, run, { target: 'Y-1', kind: 'note', body: 'hi' }),
    ).rejects.toThrow("Y-1 is not this run's item or one of its tasks")
    expect(comments).toEqual([])
  })
})

describe('listBoard', () => {
  it('counts each item tasks and how many are done, from one list of all tasks', async () => {
    const item = unit('X-1', { kind: 'item', status: 'split-review' })
    delete item.parent
    const board = await listBoard(
      trackerStub({
        list: (kind) =>
          Promise.resolve(
            kind === 'item'
              ? [item]
              : [unit('X-2', { status: 'done' }), unit('X-3'), unit('Y-2', { parent: 'Y-1' })],
          ),
      }),
      storeStub({
        liveRuns: () => Promise.resolve([]),
        isPaused: () => Promise.resolve(false),
        latestRunsEndedIn: () => Promise.resolve([]),
      }),
      workflow({ id: 'split-review' }),
      ['to-do', 'done'],
      [],
      'hold',
    )
    expect(board.columns[0]?.items).toEqual([item])
    expect(board.tasks).toEqual({ 'X-1': { done: 1, total: 2 }, 'Y-1': { done: 0, total: 1 } })
  })

  it('reads the live Runs after the tracker, so a Run that ended meanwhile is not shown', async () => {
    const item = unit('X-1', { kind: 'item', status: 'split-review' })
    delete item.parent
    let running = true
    const board = await listBoard(
      trackerStub({
        // The Run ends while the tracker is still searching.
        list: (kind) =>
          new Promise((resolve) =>
            setTimeout(() => {
              running = false
              resolve(kind === 'item' ? [item] : [])
            }, 0),
          ),
      }),
      storeStub({
        isPaused: () => Promise.resolve(false),
        latestRunsEndedIn: () => Promise.resolve([]),
        liveRuns: () =>
          Promise.resolve(running ? [{ ...run, target: 'X-1', state: 'running' as const }] : []),
      }),
      workflow({ id: 'split-review' }),
      ['to-do'],
      [],
      'hold',
    )
    expect(board.running).toEqual([])
  })

  it('marks the columns a rule watches for the engine and the ones that wait for a person', async () => {
    const watch = (status: string): Rule => ({
      id: status,
      watch: status,
      agent: 'a',
      mode: 'split',
      maxAttempts: 3,
      prompt: '',
      session: 'fresh',
      outcomes: {},
    })
    const board = await listBoard(
      trackerStub({ list: () => Promise.resolve([]) }),
      storeStub({
        liveRuns: () => Promise.resolve([]),
        isPaused: () => Promise.resolve(false),
        latestRunsEndedIn: () => Promise.resolve([]),
      }),
      workflow(
        { id: 'refining' },
        { id: 'ready-to-split' },
        { id: 'split-review', handledBy: 'person' },
        { id: 'blocked', handledBy: 'person' },
      ),
      [],
      // A rule on a status that waits for a person: the engine picks it up, so it wins.
      [watch('ready-to-split'), watch('blocked')],
      'hold',
    )
    expect(board.columns.map((c) => [c.status, c.handledBy])).toEqual([
      ['refining', undefined],
      ['ready-to-split', 'engine'],
      ['split-review', 'person'],
      ['blocked', 'engine'],
    ])
  })
})

describe('a person on a task', () => {
  const item = (status: string): WorkUnit => {
    const made = unit('X-1', { kind: 'item', status })
    delete made.parent
    delete made.origin
    return made
  }
  const units = (itemStatus: string): Record<string, WorkUnit> => ({
    'X-1': item(itemStatus),
    'X-2': unit('X-2', { status: 'manual' }),
    'X-3': unit('X-3'),
  })
  const get = (all: Record<string, WorkUnit>) => (ref: string) =>
    all[ref] ? Promise.resolve(all[ref]) : Promise.reject(new NotFound(ref))

  it('reads a task with what it waits for and its comments', async () => {
    const tracker = trackerStub({
      get: get(units('in-progress')),
      children: () => Promise.resolve([unit('X-2'), unit('X-3')]),
      dependencies: () => Promise.resolve([{ task: 'X-3', blockedBy: 'X-2' }]),
      comments: () => Promise.resolve([]),
    })
    expect(await getTask(tracker, 'X-3')).toMatchObject({
      task: { ref: 'X-3', blockedBy: ['X-2'] },
      comments: [],
    })
    await expect(getTask(tracker, 'X-1')).rejects.toBeInstanceOf(NotFound)
  })

  it('finishes a manual task and undoes a done one, logging each, but not under a live Run', async () => {
    const moves: string[] = []
    const logged: string[] = []
    let live: Run[] = []
    const deps = {
      tracker: trackerStub({
        get: get(units('blocked')),
        transition: (ref, from, to) => (
          moves.push(`${ref} ${from}>${to}`),
          Promise.resolve(unit(ref))
        ),
        addComment: (c) => (
          logged.push(`${c.target} ${c.author} ${c.kind}: ${c.body}`),
          Promise.resolve({ id: '1', createdAt: '', ...c })
        ),
      }),
      store: storeStub({ liveRuns: () => Promise.resolve(live) }),
    }
    await moveTask(deps, { ref: 'X-2', from: 'manual', to: 'done' })
    await moveTask(deps, { ref: 'X-3', from: 'done', to: 'to-do' })
    live = [{ ...run, target: 'X-1', state: 'running' }]
    await expect(moveTask(deps, { ref: 'X-3', from: 'done', to: 'manual' })).rejects.toThrow(
      'an agent is working on X-1; reopen X-3 once it is done',
    )
    await expect(moveTask(deps, { ref: 'X-3', from: 'to-do', to: 'done' })).rejects.toBeInstanceOf(
      InvalidInput,
    )
    await expect(
      moveTask(deps, { ref: 'X-1', from: 'blocked', to: 'done' }),
    ).rejects.toBeInstanceOf(NotFound)
    expect(moves).toEqual(['X-2 manual>done', 'X-3 done>to-do'])
    expect(logged).toEqual([
      'X-2 human system: Moved **Manual** → **Done**.',
      'X-3 human system: Moved **Done** → **To Do**.',
    ])
  })

  it('edits and deletes tasks at any station while no agent works on the item', async () => {
    const deleted: string[] = []
    let live: Run[] = []
    const deps = {
      tracker: trackerStub({
        get: get(units('in-progress')),
        updateItem: (ref) => Promise.resolve(unit(ref, { title: 'Renamed' })),
        deleteTask: (ref) => (deleted.push(ref), Promise.resolve()),
      }),
      store: storeStub({ liveRuns: () => Promise.resolve(live) }),
    }
    const edit = { ref: 'X-3', expectedVersion: '1', title: 'Renamed' }
    expect((await updateTask(deps, edit)).title).toBe('Renamed')
    await deleteTask(deps, 'X-3')
    expect(deleted).toEqual(['X-3'])

    // An agent on another item does not matter.
    live = [{ ...run, target: 'X-9' }]
    await deleteTask(deps, 'X-3')
    expect(deleted).toEqual(['X-3', 'X-3'])

    live = [{ ...run, target: 'X-1' }]
    const refused = 'an agent is working on X-1; stop it before changing X-3'
    await expect(updateTask(deps, edit)).rejects.toThrow(refused)
    await expect(deleteTask(deps, 'X-3')).rejects.toThrow(refused)
    await expect(deleteTask(deps, 'X-1')).rejects.toBeInstanceOf(NotFound)
    expect(deleted).toEqual(['X-3', 'X-3'])
  })
})
