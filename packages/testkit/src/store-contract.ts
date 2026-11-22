import {
  FlowConflict,
  InvalidInput,
  NotFound,
  RunConflict,
  type Clock,
  type NewRun,
  type StorePort,
} from '@tasuki/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

    it('the flow is unset until saved; each save is a version up, stamped and kept as given', async () => {
      expect(await store.latestFlow()).toBeUndefined()
      const flow = { workflow: { statuses: [{ id: 'refining' }] }, rules: [], note: null }
      expect(await store.saveFlow(undefined, flow, 'Eli')).toEqual({
        version: 1,
        flow,
        savedBy: 'Eli',
        savedAt: at(T0),
      })
      now += 1000
      await store.saveFlow(1, { rules: [] }, '')
      expect(await store.latestFlow()).toEqual({
        version: 2,
        flow: { rules: [] },
        savedBy: '',
        savedAt: at(T0 + 1000),
      })
    })

    it('a save from a version that is no longer the latest is a FlowConflict and writes nothing', async () => {
      await expect(store.saveFlow(1, {}, 'Eli')).rejects.toBeInstanceOf(FlowConflict)
      await store.saveFlow(undefined, { a: 1 }, 'Eli')
      await store.saveFlow(1, { a: 2 }, 'Eli')
      await expect(store.saveFlow(1, { a: 3 }, 'Kai')).rejects.toBeInstanceOf(FlowConflict)
      await expect(store.saveFlow(undefined, { a: 3 }, 'Kai')).rejects.toBeInstanceOf(FlowConflict)
      expect(await store.latestFlow()).toMatchObject({ version: 2, flow: { a: 2 } })
    })

    it('the history holds every save, newest first, each as it was saved', async () => {
      expect(await store.flowHistory()).toEqual([])
      await store.saveFlow(undefined, { a: 1 }, 'Eli')
      now += 1000
      await store.saveFlow(1, { a: 2 }, 'Kai')
      expect(await store.flowHistory()).toEqual([
        { version: 2, flow: { a: 2 }, savedBy: 'Kai', savedAt: at(T0 + 1000) },
        { version: 1, flow: { a: 1 }, savedBy: 'Eli', savedAt: at(T0) },
      ])
    })

    const newAccount = (userId: string, username = userId) => ({
      userId,
      username,
      displayName: `Name of ${userId}`,
      access: 'member' as const,
    })

    it('accounts start enabled, stamped from the clock, listed oldest first', async () => {
      await store.createAccount({ ...newAccount('u2'), access: 'admin' })
      now += 1000
      await store.createAccount(newAccount('u1'))
      expect(await store.getAccount('u2')).toEqual({
        userId: 'u2',
        username: 'u2',
        displayName: 'Name of u2',
        access: 'admin',
        disabled: false,
        createdAt: at(T0),
      })
      expect((await store.findAccount('u1'))?.userId).toBe('u1')
      expect(await store.findAccount('nobody')).toBeUndefined()
      expect(await store.getAccount('nobody')).toBeUndefined()
      expect((await store.listAccounts()).map((a) => a.userId)).toEqual(['u2', 'u1'])
    })

    it('a taken userId or username is InvalidInput', async () => {
      await store.createAccount(newAccount('u1', 'eli'))
      await expect(store.createAccount(newAccount('u1', 'other'))).rejects.toThrow(InvalidInput)
      await expect(store.createAccount(newAccount('u2', 'eli'))).rejects.toThrow(InvalidInput)
    })

    it('updateAccount changes only what it is given, and NotFound for an unknown one', async () => {
      await store.createAccount(newAccount('u1'))
      expect(await store.updateAccount('u1', { access: 'maintainer' })).toMatchObject({
        access: 'maintainer',
        displayName: 'Name of u1',
        disabled: false,
      })
      expect(await store.updateAccount('u1', { disabled: true, displayName: 'New' })).toMatchObject(
        {
          access: 'maintainer',
          displayName: 'New',
          disabled: true,
        },
      )
      expect((await store.updateAccount('u1', { disabled: false })).disabled).toBe(false)
      await expect(store.updateAccount('nobody', { access: 'admin' })).rejects.toThrow(NotFound)
    })

    it('keeps a password hash only when one is given or set', async () => {
      await store.createAccount(newAccount('u1'))
      await store.createAccount({ ...newAccount('u2'), passwordHash: 'h2' })
      expect(await store.passwordHash('u1')).toBeUndefined()
      expect(await store.passwordHash('u2')).toBe('h2')
      await store.setPasswordHash('u1', 'h1')
      expect(await store.passwordHash('u1')).toBe('h1')
      expect(await store.getAccount('u1')).not.toHaveProperty('passwordHash')
    })

    it('sessions are found by their hash and gone once deleted', async () => {
      await store.createAccount(newAccount('u1'))
      await store.createSession('s1', { userId: 'u1', ttl: '7d', expiresAt: at(T0 + 5000) })
      await store.createSession('s2', { userId: 'u1', ttl: 'never' })
      expect(await store.getSession('s1')).toEqual({
        userId: 'u1',
        ttl: '7d',
        expiresAt: at(T0 + 5000),
        createdAt: at(T0),
      })
      expect(await store.getSession('s2')).toEqual({
        userId: 'u1',
        ttl: 'never',
        createdAt: at(T0),
      })
      await store.deleteSession('s1')
      expect(await store.getSession('s1')).toBeUndefined()
      expect(await store.getSession('s2')).toBeDefined()
    })

    it('API tokens are found by their hash, listed per person oldest first, and deleted by id', async () => {
      await store.createAccount(newAccount('u1'))
      await store.createAccount(newAccount('u2'))
      const a = await store.createApiToken('ha', { userId: 'u1', name: 'laptop' })
      const b = await store.createApiToken('hb', {
        userId: 'u1',
        name: 'ci',
        expiresAt: at(T0 + 9000),
      })
      await store.createApiToken('hc', { userId: 'u2', name: 'other' })
      expect(a).toEqual({ id: expect.any(String), userId: 'u1', name: 'laptop', createdAt: at(T0) })
      expect(await store.apiTokenByHash('hb')).toEqual(b)
      expect((await store.apiTokensOf('u1')).map((t) => t.name)).toEqual(['laptop', 'ci'])
      await store.deleteApiToken(a.id)
      expect(await store.apiTokenByHash('ha')).toBeUndefined()
      expect((await store.apiTokensOf('u1')).map((t) => t.name)).toEqual(['ci'])
    })

    it('makes a userId when given none, and binds an externalId only one account holds', async () => {
      const added = await store.createAccount({
        username: 'eli',
        displayName: 'eli',
        access: 'member',
      })
      expect(added.userId).not.toBe('')
      expect(added).not.toHaveProperty('externalId')
      expect(await store.findAccountByExternalId('emp-1')).toBeUndefined()
      expect((await store.updateAccount(added.userId, { externalId: 'emp-1' })).externalId).toBe(
        'emp-1',
      )
      expect((await store.findAccountByExternalId('emp-1'))?.userId).toBe(added.userId)
      const other = await store.createAccount({
        username: 'amy',
        displayName: 'amy',
        access: 'member',
        externalId: 'emp-2',
      })
      expect(other.externalId).toBe('emp-2')
      await expect(store.updateAccount(other.userId, { externalId: 'emp-1' })).rejects.toThrow(
        InvalidInput,
      )
    })

    it('deleting an account takes its sessions and API tokens with it, and nobody else’s', async () => {
      await store.createAccount(newAccount('u1'))
      await store.createAccount(newAccount('u2'))
      await store.createSession('s1', { userId: 'u1', ttl: 'never' })
      await store.createSession('s2', { userId: 'u2', ttl: 'never' })
      await store.createApiToken('h1', { userId: 'u1', name: 'laptop' })
      await store.deleteAccount('u1')
      expect(await store.getAccount('u1')).toBeUndefined()
      expect(await store.getSession('s1')).toBeUndefined()
      expect(await store.apiTokenByHash('h1')).toBeUndefined()
      expect(await store.getSession('s2')).toBeDefined()
      // The username is free again.
      await store.createAccount(newAccount('u3', 'u1'))
    })
  })
}
