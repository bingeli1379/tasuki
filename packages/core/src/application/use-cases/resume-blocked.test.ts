import { describe, expect, it } from 'vite-plus/test'
import type { Rule } from '../../domain/rule'
import type { Outcome, Run } from '../../domain/run'
import type { WorkUnit } from '../../domain/work-unit'
import { runtimeStub } from '../../testing/runtime-stub'
import { storageStub } from '../../testing/storage-stub'
import type { NewComment } from '../ports/storage'
import { StatusConflict } from '../status-conflict'
import { resumeBlocked } from './resume-blocked'

const execute: Rule = {
  id: 'execute',
  watch: 'in-progress',
  agent: 'a',
  mode: 'execute',
  maxAttempts: 3,
  prompt: '',
  session: 'fresh',
  on: { succeeded: 'in-review', needs_input: 'blocked', blocked_manual: 'blocked' },
}

const unit = (ref: string, over: Partial<WorkUnit> = {}): WorkUnit => ({
  ref,
  kind: 'item',
  title: ref,
  body: '',
  status: 'blocked',
  labels: [],
  version: '1',
  ...over,
})

const run = (outcome: Outcome | undefined, over: Partial<Run> = {}): Run => ({
  id: 'r1',
  target: 'X-1',
  rule: 'execute',
  agent: 'a',
  attempt: 1,
  workspace: '',
  state: outcome === undefined ? 'running' : 'finished',
  ...(outcome === undefined ? {} : { outcome }),
  produced: { questions: 0, tasks: 0 },
  leaseUntil: '',
  startedAt: '',
  lastActivityAt: '',
  logPath: '',
  ...over,
})

const setup = (opts: {
  item?: Partial<WorkUnit>
  runs?: Run[]
  tasks?: string[]
  conflict?: boolean
}) => {
  const moves: string[] = []
  const comments: NewComment[] = []
  const deps = {
    named: (s: string) => s,
    storage: storageStub({
      list: () => Promise.resolve([unit('X-1', opts.item)]),
      children: () =>
        Promise.resolve(
          (opts.tasks ?? ['done']).map((status, i) =>
            unit(`X-${i + 2}`, { kind: 'task', parent: 'X-1', status }),
          ),
        ),
      transition: (ref, from, to) => {
        if (opts.conflict === true)
          return Promise.reject(new StatusConflict(from, unit(ref, { status: 'refining' })))
        moves.push(`${ref} ${from}>${to}`)
        return Promise.resolve(unit(ref, { status: to }))
      },
      addComment: (c) => (comments.push(c), Promise.resolve({ ...c, id: '1', createdAt: '' })),
    }),
    // What the store answers: the newest Run, when it ended in the outcome asked for.
    runtime: runtimeStub({
      latestRunsEndedIn: (outcome) =>
        Promise.resolve(
          (opts.runs ?? [run('blocked_manual')]).slice(0, 1).filter((r) => r.outcome === outcome),
        ),
    }),
  }
  return { deps, moves, comments }
}

// state-machine.md, auto-resume: all three conditions, and nothing when any one fails.
describe('resumeBlocked', () => {
  it('moves the item back to the watch status once no task is manual', async () => {
    const { deps, moves, comments } = setup({ tasks: ['done', 'done'] })
    expect(await resumeBlocked(deps, [execute], 'hold')).toEqual(['X-1'])
    expect(moves).toEqual(['X-1 blocked>in-progress'])
    expect(comments).toMatchObject([{ target: 'X-1', author: 'engine', kind: 'system' }])
  })

  it.each([
    ['a task is still manual', { tasks: ['done', 'manual'] }],
    ['the last Run did not stop at manual tasks', { runs: [run('failed')] }],
    ['the last Run is still running', { runs: [run(undefined), run('blocked_manual')] }],
    ['no Run ever ran on it', { runs: [] }],
    ['the item is on hold', { item: { labels: ['hold'] } }],
    ['the rule would not have parked it there', { item: { status: 'in-review' } }],
  ])('leaves it when %s', async (_, opts) => {
    const { deps, moves, comments } = setup(opts)
    expect(await resumeBlocked(deps, [execute], 'hold')).toEqual([])
    expect(moves).toEqual([])
    expect(comments).toEqual([])
  })

  it('a person moving it first wins, without a comment', async () => {
    const { deps, comments } = setup({ conflict: true })
    expect(await resumeBlocked(deps, [execute], 'hold')).toEqual([])
    expect(comments).toEqual([])
  })

  it('asks the tracker nothing while no Run stopped at manual tasks', async () => {
    const runtime = runtimeStub({ latestRunsEndedIn: () => Promise.resolve([]) })
    expect(
      await resumeBlocked(
        { storage: storageStub({}), runtime, named: (s) => s },
        [execute],
        'hold',
      ),
    ).toEqual([])
  })

  it('reads nothing when no rule parks items on manual tasks', async () => {
    const split: Rule = {
      ...execute,
      id: 'split',
      mode: 'split',
      on: { succeeded: 'split-review' },
    }
    expect(
      await resumeBlocked(
        { storage: storageStub({}), runtime: runtimeStub({}), named: (s) => s },
        [split],
        'hold',
      ),
    ).toEqual([])
  })
})
