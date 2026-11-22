import {
  InvalidInput,
  NotFound,
  RunConflict,
  type Clock,
  type NewRun,
  type StorePort,
} from '@tasuki/core'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

export interface StoreFixture {
  store: StorePort
  teardown?: () => Promise<void>
}

const T0 = Date.parse('2026-11-20T12:00:00Z')
const at = (ms: number): string => new Date(ms).toISOString()

const newRun = (target: string, extra: Partial<NewRun> = {}): NewRun => ({
  target,
  rule: 'split',
  agent: 'fake',
  attempt: 1,
  from: 'ready-to-split',
  workspace: `/ws/${target}`,
  leaseSeconds: 120,
  ...extra,
})

// Every store plugin runs this suite. setup is called before each test and must return an
// empty store that stamps times from the clock it is given.
export function describeStoreContract(
  name: string,
  setup: (clock: Clock) => Promise<StoreFixture>,
): void {
  describe(`StorePort contract: ${name}`, () => {
    let fixture: StoreFixture
    let store: StorePort
    let now: number
    const clock: Clock = { now: () => new Date(now) }

    beforeEach(async () => {
      now = T0
      fixture = await setup(clock)
      store = fixture.store
    })
    afterEach(async () => {
      await fixture.teardown?.()
    })

    it('createRun returns a running Run stamped from the clock, and getRun reads it back', async () => {
      const run = await store.createRun(newRun('T-1', { attempt: 2 }))
      expect(run).toEqual({
        id: expect.any(String),
        target: 'T-1',
        rule: 'split',
        agent: 'fake',
        attempt: 2,
        from: 'ready-to-split',
        workspace: '/ws/T-1',
        state: 'running',
        produced: { questions: 0, tasks: 0 },
        leaseUntil: at(T0 + 120_000),
        startedAt: at(T0),
        lastActivityAt: at(T0),
      })
      expect(await store.getRun(run.id)).toEqual(run)
    })

    it('getRun throws NotFound for an unknown id', async () => {
      await expect(store.getRun('nope')).rejects.toThrow(NotFound)
    })

    it('one live Run per target: a second throws RunConflict until the first is finished', async () => {
      const first = await store.createRun(newRun('T-1'))
      await store.createRun(newRun('T-2'))
      await expect(store.createRun(newRun('T-1'))).rejects.toThrow(RunConflict)
      await store.finishRun(first.id, 'succeeded')
      const second = await store.createRun(newRun('T-1'))
      expect(second.id).not.toBe(first.id)
    })

    it('renewLease, touch and recordSession update a live Run', async () => {
      const run = await store.createRun(newRun('T-1'))
      now = T0 + 60_000
      await store.renewLease(run.id, 120)
      await store.touch(run.id)
      await store.recordSession(run.id, 'session-1')
      expect(await store.getRun(run.id)).toMatchObject({
        leaseUntil: at(T0 + 180_000),
        lastActivityAt: at(T0 + 60_000),
        sessionId: 'session-1',
      })
    })

    it('renewLease and touch leave a finished Run alone', async () => {
      const run = await store.createRun(newRun('T-1'))
      await store.finishRun(run.id, 'succeeded')
      now = T0 + 60_000
      await store.renewLease(run.id, 120)
      await store.touch(run.id)
      expect(await store.getRun(run.id)).toMatchObject({
        leaseUntil: at(T0 + 120_000),
        lastActivityAt: at(T0),
      })
    })

    it('report keeps the first result and refuses a second, or one after the Run is over', async () => {
      const run = await store.createRun(newRun('T-1'))
      await store.report(run.id, 'succeeded', 'split into 2 tasks')
      await expect(store.report(run.id, 'failed', 'again')).rejects.toThrow(InvalidInput)
      expect(await store.getRun(run.id)).toMatchObject({
        verdict: 'succeeded',
        summary: 'split into 2 tasks',
      })
      const over = await store.createRun(newRun('T-2'))
      await store.finishRun(over.id, 'abandoned')
      await expect(store.report(over.id, 'succeeded', 'late')).rejects.toThrow(InvalidInput)
    })

    it('bumpProduced counts questions and tasks apart', async () => {
      const run = await store.createRun(newRun('T-1'))
      await store.bumpProduced(run.id, 'tasks')
      await store.bumpProduced(run.id, 'tasks')
      await store.bumpProduced(run.id, 'questions')
      expect((await store.getRun(run.id)).produced).toEqual({ questions: 1, tasks: 2 })
    })

    it('finishRun records the outcome, the time and where the item went, once', async () => {
      const run = await store.createRun(newRun('T-1'))
      now = T0 + 5_000
      // Outcomes are whatever a rule names (W2), not a fixed list.
      await store.finishRun(run.id, 'approve', 'in-review')
      now = T0 + 9_000
      await store.finishRun(run.id, 'abandoned')
      expect(await store.getRun(run.id)).toMatchObject({
        state: 'finished',
        outcome: 'approve',
        to: 'in-review',
        finishedAt: at(T0 + 5_000),
      })
      const cancelled = await store.createRun(newRun('T-2'))
      await store.finishRun(cancelled.id, 'cancelled')
      expect(await store.getRun(cancelled.id)).not.toHaveProperty('to')
    })

    it('requestCancel keeps the first time; hard overrides soft and its reason, never back', async () => {
      const run = await store.createRun(newRun('T-1'))
      await store.requestCancel(run.id, 'soft', 'hold')
      now = T0 + 1_000
      await store.requestCancel(run.id, 'soft', 'moved')
      expect(await store.getRun(run.id)).toMatchObject({
        cancelRequestedAt: at(T0),
        cancelMode: 'soft',
        cancelRequestedBy: 'hold',
      })
      await store.requestCancel(run.id, 'hard', 'stop')
      await store.requestCancel(run.id, 'soft', 'hold')
      expect(await store.getRun(run.id)).toMatchObject({
        cancelRequestedAt: at(T0),
        cancelMode: 'hard',
        cancelRequestedBy: 'stop',
      })
    })

    it('requestCancel leaves a finished Run alone', async () => {
      const run = await store.createRun(newRun('T-1'))
      await store.finishRun(run.id, 'succeeded')
      await store.requestCancel(run.id, 'hard', 'stop')
      expect(await store.getRun(run.id)).not.toHaveProperty('cancelMode')
    })

    it('liveRuns and runsFor list newest first, even within one millisecond', async () => {
      const a = await store.createRun(newRun('T-1'))
      await store.finishRun(a.id, 'failed')
      const b = await store.createRun(newRun('T-1'))
      const c = await store.createRun(newRun('T-2'))
      expect((await store.liveRuns()).map((r) => r.id)).toEqual([c.id, b.id])
      expect((await store.runsFor('T-1')).map((r) => r.id)).toEqual([b.id, a.id])
      expect(await store.runsFor('T-9')).toEqual([])
    })

    it('latestRunsEndedIn looks only at the newest Run of each target', async () => {
      const a1 = await store.createRun(newRun('T-1'))
      await store.finishRun(a1.id, 'blocked_manual')
      const b1 = await store.createRun(newRun('T-2'))
      await store.finishRun(b1.id, 'blocked_manual')
      const b2 = await store.createRun(newRun('T-2'))
      await store.finishRun(b2.id, 'succeeded')
      await store.createRun(newRun('T-3'))
      expect((await store.latestRunsEndedIn('blocked_manual')).map((r) => r.id)).toEqual([a1.id])
    })

    it('the pause starts off and can be set and cleared any number of times', async () => {
      expect(await store.isPaused()).toBe(false)
      await store.setPaused(true)
      await store.setPaused(true)
      expect(await store.isPaused()).toBe(true)
      await store.setPaused(false)
      await store.setPaused(false)
      expect(await store.isPaused()).toBe(false)
    })
  })
}
