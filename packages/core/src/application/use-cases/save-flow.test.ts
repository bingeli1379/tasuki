import { describe, expect, it } from 'vite-plus/test'
import type { Account } from '../../domain/account'
import type { Kind, WorkUnit } from '../../domain/work-unit'
import { storeStub } from '../../testing/store-stub'
import { trackerStub } from '../../testing/tracker-stub'
import { Forbidden } from '../forbidden'
import { InvalidInput } from '../invalid-input'
import type { TrackerPort } from '../ports/tracker'
import type { StatusMapping } from '../status-map'
import { saveFlow } from './save-flow'

const actor = (access: Account['access']): Account => ({
  userId: 'u1',
  username: 'eli',
  displayName: 'Eli',
  access,
  disabled: false,
  createdAt: '2026-11-22T00:00:00.000Z',
})

const unit = (ref: string, kind: Kind, status: string): WorkUnit =>
  ({ ref, kind, status }) as WorkUnit

const current: StatusMapping = {
  item: { refining: 'refining', 'in-review': 'in-review' },
  task: { 'to-do': 'to-do' },
}

// Units by logical status, the way the tracker reads them through the current mapping.
function tracker(units: WorkUnit[], held?: Record<Kind, string[]>): TrackerPort {
  return trackerStub({
    list: async (kind, statuses) =>
      units.filter((u) => u.kind === kind && statuses.includes(u.status)),
    ...(held === undefined
      ? // Present but unset, as on sqlite: the stub would answer a missing key itself.
        ({ listStatuses: undefined } as unknown as Partial<TrackerPort>)
      : { listStatuses: async (kind) => held[kind].map((key) => ({ key, name: key })) }),
  })
}

const store = storeStub({
  saveFlow: async (expected, flow, savedBy) => ({
    version: (expected ?? 0) + 1,
    flow,
    savedBy,
    savedAt: '2026-11-22T00:00:00.000Z',
  }),
})

describe('saveFlow', () => {
  it('saves under the name of whoever saved it', async () => {
    const saved = await saveFlow({ tracker: tracker([]), store }, actor('maintainer'), current, {
      expected: 3,
      flow: { x: 1 },
      mapping: current,
    })
    expect(saved).toMatchObject({ version: 4, flow: { x: 1 }, savedBy: 'Eli' })
  })

  it('a member cannot', async () => {
    await expect(
      saveFlow({ tracker: tracker([]), store }, actor('member'), current, {
        expected: undefined,
        flow: {},
        mapping: current,
      }),
    ).rejects.toBeInstanceOf(Forbidden)
  })

  it('refuses dropping or rekeying a status that still has units, naming them', async () => {
    const units = [
      unit('TSK-1', 'item', 'in-review'),
      unit('TSK-2', 'item', 'refining'),
      unit('TSK-3', 'task', 'to-do'),
    ]
    const change = {
      expected: 1,
      flow: {},
      mapping: { item: { refining: 'Refining' }, task: { 'to-do': 'to-do' } },
    }
    await expect(
      saveFlow({ tracker: tracker(units), store }, actor('admin'), current, change),
    ).rejects.toThrow(/TSK-1 \(in-review\), TSK-2 \(refining\)$/)
    // A status nobody is in goes quietly.
    await expect(
      saveFlow(
        { tracker: tracker([units[2] as WorkUnit]), store },
        actor('admin'),
        current,
        change,
      ),
    ).resolves.toMatchObject({ version: 2 })
  })

  it('does not look for units in a status the tracker never held, as on the first save on Jira', async () => {
    const held = { item: ['10003', '10004'], task: ['10001'] }
    const units = [unit('KAN-1', 'item', 'refining')]
    const asked: string[][] = []
    const jira = trackerStub({
      list: async (kind, statuses) => {
        asked.push([...statuses])
        return units.filter((u) => u.kind === kind && statuses.includes(u.status))
      },
      listStatuses: async (kind) => held[kind].map((key) => ({ key, name: key })),
    })
    const saved = await saveFlow({ tracker: jira, store }, actor('admin'), current, {
      expected: undefined,
      flow: {},
      mapping: { item: { refining: '10003', 'in-review': '10004' }, task: { 'to-do': '10001' } },
    })
    expect(saved.version).toBe(1)
    expect(asked).toEqual([])
  })

  it('refuses a key the tracker does not hold, when it holds a fixed set', async () => {
    const held = { item: ['refining', 'in-review'], task: [] }
    await expect(
      saveFlow({ tracker: tracker([], held), store }, actor('admin'), current, {
        expected: 1,
        flow: {},
        mapping: current,
      }),
    ).rejects.toThrow(new InvalidInput('not a status in the tracker: task to-do'))
  })
})
