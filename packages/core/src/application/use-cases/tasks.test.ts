import { describe, expect, it } from 'vite-plus/test'
import type { Rule } from '../../domain/rule'
import type { Run } from '../../domain/run'
import type { WorkUnit } from '../../domain/work-unit'
import { runtimeStub } from '../../testing/runtime-stub'
import { storageStub } from '../../testing/storage-stub'
import { InvalidInput } from '../invalid-input'
import { NotFound } from '../not-found'
import type { NewComment, NewTask } from '../ports/storage'
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
  logPath: '',
}

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
        storage: storageStub({
          createTask: (_item, task) => (tasks.push(task), Promise.resolve(unit('X-2'))),
        }),
        runtime: runtimeStub({ bumpProduced: (_id, key) => (bumped.push(key), Promise.resolve()) }),
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
        storage: storageStub({
          children: () => Promise.resolve([unit('X-2')]),
          addComment: (c) => (comments.push(c), Promise.resolve({ id: '1', ...c, createdAt: '' })),
        }),
        runtime: runtimeStub({ bumpProduced: (_id, key) => (bumped.push(key), Promise.resolve()) }),
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
      storageStub({
        list: (kind) =>
          Promise.resolve(
            kind === 'item'
              ? [item]
              : [unit('X-2', { status: 'done' }), unit('X-3'), unit('Y-2', { parent: 'Y-1' })],
          ),
      }),
      runtimeStub({ liveRuns: () => Promise.resolve([]) }),
      { item: ['split-review'], task: ['to-do', 'done'] },
      [],
    )
    expect(board.columns[0]?.items).toEqual([item])
    expect(board.tasks).toEqual({ 'X-1': { done: 1, total: 2 }, 'Y-1': { done: 0, total: 1 } })
  })

  it('reads the live Runs after the tracker, so a Run that ended meanwhile is not shown', async () => {
    const item = unit('X-1', { kind: 'item', status: 'split-review' })
    delete item.parent
    let running = true
    const board = await listBoard(
      storageStub({
        // The Run ends while the tracker is still searching.
        list: (kind) =>
          new Promise((resolve) =>
            setTimeout(() => {
              running = false
              resolve(kind === 'item' ? [item] : [])
            }, 0),
          ),
      }),
      runtimeStub({
        liveRuns: () =>
          Promise.resolve(running ? [{ ...run, target: 'X-1', state: 'running' as const }] : []),
      }),
      { item: ['split-review'], task: ['to-do'] },
      [],
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
      on: {},
    })
    const board = await listBoard(
      storageStub({ list: () => Promise.resolve([]) }),
      runtimeStub({ liveRuns: () => Promise.resolve([]) }),
      { item: ['refining', 'ready-to-split', 'split-review', 'blocked'], task: [] },
      // A rule on a status that would wait for a person: the engine picks it up, so it wins.
      [watch('ready-to-split'), watch('blocked')],
    )
    expect(board.columns.map((c) => [c.status, c.turn])).toEqual([
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
    const storage = storageStub({
      get: get(units('in-progress')),
      children: () => Promise.resolve([unit('X-2'), unit('X-3')]),
      dependencies: () => Promise.resolve([{ task: 'X-3', blockedBy: 'X-2' }]),
      comments: () => Promise.resolve([]),
    })
    expect(await getTask(storage, 'X-3')).toMatchObject({
      task: { ref: 'X-3', blockedBy: ['X-2'] },
      comments: [],
    })
    await expect(getTask(storage, 'X-1')).rejects.toBeInstanceOf(NotFound)
  })

  it('finishes a manual task, and may not reopen a done one', async () => {
    const moves: string[] = []
    const storage = storageStub({
      get: get(units('blocked')),
      transition: (ref, from, to) => (
        moves.push(`${ref} ${from}>${to}`),
        Promise.resolve(unit(ref))
      ),
    })
    await moveTask(storage, { ref: 'X-2', from: 'manual', to: 'done' })
    await expect(moveTask(storage, { ref: 'X-3', from: 'done', to: 'manual' })).rejects.toThrow(
      'X-3 is done; done tasks are never reopened',
    )
    await expect(
      moveTask(storage, { ref: 'X-1', from: 'blocked', to: 'done' }),
    ).rejects.toBeInstanceOf(NotFound)
    expect(moves).toEqual(['X-2 manual>done'])
  })

  it('edits and deletes tasks only while the item is in split-review', async () => {
    const deleted: string[] = []
    const storageIn = (status: string) =>
      storageStub({
        get: get(units(status)),
        updateItem: (ref) => Promise.resolve(unit(ref, { title: 'Renamed' })),
        deleteTask: (ref) => (deleted.push(ref), Promise.resolve()),
      })
    const edit = { ref: 'X-3', expectedVersion: '1', title: 'Renamed' }
    expect((await updateTask(storageIn('split-review'), edit)).title).toBe('Renamed')
    await deleteTask(storageIn('split-review'), 'X-3')
    expect(deleted).toEqual(['X-3'])

    const refused = 'X-3 can only be changed while X-1 is in split-review; it is in in-progress'
    await expect(updateTask(storageIn('in-progress'), edit)).rejects.toThrow(refused)
    await expect(deleteTask(storageIn('in-progress'), 'X-3')).rejects.toThrow(refused)
    await expect(deleteTask(storageIn('split-review'), 'X-1')).rejects.toBeInstanceOf(NotFound)
    expect(deleted).toEqual(['X-3'])
  })
})
