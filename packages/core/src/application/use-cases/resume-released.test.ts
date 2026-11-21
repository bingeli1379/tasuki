import { describe, expect, it } from 'vite-plus/test'
import type { Rule } from '../../domain/rule'
import type { CancelReason, Run } from '../../domain/run'
import type { WorkUnit } from '../../domain/work-unit'
import { runtimeStub } from '../../testing/runtime-stub'
import { storageStub } from '../../testing/storage-stub'
import { resumeReleased } from './resume-released'

const split: Rule = {
  id: 'split',
  watch: 'ready-to-split',
  claim: 'splitting',
  agent: 'a',
  mode: 'split',
  maxAttempts: 3,
  prompt: '',
  session: 'fresh',
  on: { succeeded: 'split-review', needs_input: 'needs-answers' },
}

const item = (labels: string[] = []): WorkUnit => ({
  ref: 'X-1',
  kind: 'item',
  title: 'X-1',
  body: '',
  status: 'splitting',
  labels,
  version: '1',
})

const cancelled = (by?: CancelReason): Run => ({
  id: 'r1',
  target: 'X-1',
  rule: 'split',
  agent: 'a',
  attempt: 1,
  workspace: '',
  state: 'finished',
  outcome: 'cancelled',
  ...(by === undefined ? {} : { cancelRequestedAt: '', cancelMode: 'hard', cancelRequestedBy: by }),
  produced: { questions: 0, tasks: 0 },
  leaseUntil: '',
  startedAt: '',
  lastActivityAt: '',
  logPath: '',
})

const setup = (runs: Run[], labels: string[] = []) => {
  const moves: string[] = []
  const deps = {
    storage: storageStub({
      list: () => Promise.resolve([item(labels)]),
      transition: (ref, from, to) => {
        moves.push(`${ref} ${from}->${to}`)
        return Promise.resolve({ ...item(labels), status: to })
      },
      addComment: (c) => Promise.resolve({ id: '1', ...c, createdAt: '' }),
    }),
    runtime: runtimeStub({ latestRunsEndedIn: () => Promise.resolve(runs) }),
  }
  return { deps, moves }
}

describe('resumeReleased', () => {
  it('sends an item stopped in its claim status back to watch once the hold is off', async () => {
    const t = setup([cancelled('stop')])
    expect(await resumeReleased(t.deps, [split], 'hold')).toEqual(['X-1'])
    expect(t.moves).toEqual(['X-1 splitting->ready-to-split'])
  })

  it('leaves it while it is still on hold', async () => {
    const t = setup([cancelled('hold')], ['hold'])
    expect(await resumeReleased(t.deps, [split], 'hold')).toEqual([])
  })

  // A Run cancelled because a person moved the item: they decide where it goes.
  it('asks the tracker nothing when no Run was stopped or held', async () => {
    const t = setup([cancelled(), cancelled('moved')])
    t.deps.storage = storageStub({})
    expect(await resumeReleased(t.deps, [split], 'hold')).toEqual([])
  })
})
