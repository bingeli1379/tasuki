import { describe, expect, it } from 'vite-plus/test'
import type { Transition } from '../domain/transition'
import type { WorkUnit } from '../domain/work-unit'
import { storeStub } from '../testing/store-stub'
import { trackerStub } from '../testing/tracker-stub'
import type { TrackerPort } from './ports/tracker'
import { withSharedStatuses } from './shared-statuses'
import { StatusConflict } from './status-conflict'
import { createStatusMap } from './status-map'

// Jira-like: To Do holds refining and split-done, In Progress holds in-progress and reviewing.
const map = createStatusMap({
  item: {
    refining: 'todo',
    'split-done': 'todo',
    'in-progress': 'doing',
    reviewing: 'doing',
    done: 'done',
  },
  task: { 'to-do': 'todo', 'in-progress': 'doing', done: 'done' },
})

function setup() {
  // What the tracker holds: each unit's tracker key.
  const keys = new Map<string, { kind: 'item' | 'task'; key: string }>()
  const entries = new Map<string, string>()
  const calls: string[] = []
  let next = 1
  const unit = (ref: string): WorkUnit => {
    const held = keys.get(ref)
    if (held === undefined) throw new Error(`no ${ref}`)
    return {
      ref,
      kind: held.kind,
      title: ref,
      body: '',
      status: map.fromTracker(held.kind, held.key) ?? held.key,
      labels: [],
      version: '1',
    }
  }
  const doctored: Transition[][] = []
  const tracker: TrackerPort = trackerStub({
    list: async (kind, statuses) => {
      const wanted = statuses.map((s) => map.toTracker(kind, s))
      return [...keys]
        .filter(([, h]) => h.kind === kind && wanted.includes(h.key))
        .map(([ref]) => unit(ref))
    },
    get: async (ref) => unit(ref),
    createItem: async (item) => {
      const ref = `T-${next++}`
      keys.set(ref, { kind: 'item', key: map.toTracker('item', item.status) })
      return unit(ref)
    },
    transition: async (ref, from, to) => {
      const held = keys.get(ref)
      if (held === undefined) throw new Error(`no ${ref}`)
      calls.push(`${ref} ${from} → ${to}`)
      if (held.key !== map.toTracker(held.kind, from)) throw new StatusConflict(from, unit(ref))
      held.key = map.toTracker(held.kind, to)
      return unit(ref)
    },
    deleteItem: async (ref) => void keys.delete(ref),
    doctor: async (transitions) => {
      doctored.push([...transitions])
      return []
    },
  })
  const store = storeStub({
    itemStatuses: async (refs) =>
      Object.fromEntries(refs.flatMap((r) => (entries.has(r) ? [[r, entries.get(r) ?? '']] : []))),
    setItemStatus: async (ref, expected, status) => {
      if (entries.get(ref) !== expected) return false
      if (status === undefined) entries.delete(ref)
      else entries.set(ref, status)
      return true
    },
  })
  const shared = withSharedStatuses(tracker, store, map)
  const add = async (status: string) =>
    (await shared.createItem({ title: '', body: '', status })).ref
  return { shared, keys, entries, calls, doctored, add }
}

describe('withSharedStatuses (D104)', () => {
  it('moves inside a group in the store only, and reads the station back', async () => {
    const { shared, keys, entries, calls, add } = setup()
    const ref = await add('refining')
    expect((await shared.transition(ref, 'refining', 'split-done')).status).toBe('split-done')
    expect(calls).toEqual([])
    expect(keys.get(ref)?.key).toBe('todo')
    expect(entries.get(ref)).toBe('split-done')
    expect((await shared.get(ref)).status).toBe('split-done')
    await shared.transition(ref, 'split-done', 'refining')
    expect(entries.has(ref)).toBe(false)
    expect((await shared.get(ref)).status).toBe('refining')
  })

  it('lists only the stations asked for, though the tracker holds them under one status', async () => {
    const { shared, add } = setup()
    const a = await add('refining')
    const b = await add('split-done')
    const refs = async (statuses: string[]) =>
      (await shared.list('item', statuses)).map((u) => `${u.ref} ${u.status}`)
    expect(await refs(['refining'])).toEqual([`${a} refining`])
    expect(await refs(['split-done'])).toEqual([`${b} split-done`])
    expect(await refs(['refining', 'split-done'])).toEqual([`${a} refining`, `${b} split-done`])
  })

  it('moves across groups in the tracker, then records the station it lands in', async () => {
    const { shared, keys, entries, calls, add } = setup()
    const ref = await add('split-done')
    expect((await shared.transition(ref, 'split-done', 'reviewing')).status).toBe('reviewing')
    expect(calls).toEqual([`${ref} split-done → reviewing`])
    expect(keys.get(ref)?.key).toBe('doing')
    expect(entries.get(ref)).toBe('reviewing')
    await shared.transition(ref, 'reviewing', 'done')
    expect(entries.has(ref)).toBe(false)
    expect((await shared.get(ref)).status).toBe('done')
  })

  it('refuses a move from the wrong station of the right group, in or out of the group', async () => {
    const { shared, calls, add } = setup()
    const ref = await add('refining')
    await expect(shared.transition(ref, 'split-done', 'refining')).rejects.toBeInstanceOf(
      StatusConflict,
    )
    await expect(shared.transition(ref, 'split-done', 'in-progress')).rejects.toMatchObject({
      current: { status: 'refining' },
    })
    expect(calls).toEqual([])
  })

  it('loses a race inside a group as a StatusConflict', async () => {
    const { shared, entries, add } = setup()
    const ref = await add('refining')
    const moves = await Promise.allSettled([
      shared.transition(ref, 'refining', 'split-done'),
      shared.transition(ref, 'refining', 'split-done'),
    ])
    expect(moves.map((m) => m.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(entries.get(ref)).toBe('split-done')
  })

  it('follows the tracker once the item was moved off the group there, for good', async () => {
    const { shared, keys, entries, add } = setup()
    const ref = await add('split-done')
    const held = keys.get(ref)
    if (held) held.key = 'done'
    expect((await shared.get(ref)).status).toBe('done')
    expect(entries.has(ref)).toBe(false)
    if (held) held.key = 'todo'
    expect((await shared.list('item', ['refining'])).map((u) => u.ref)).toEqual([ref])
  })

  it('records an item created past the first station, and forgets a deleted one', async () => {
    const { shared, entries, add } = setup()
    const ref = await add('split-done')
    expect(entries.get(ref)).toBe('split-done')
    expect(entries.size).toBe(1)
    await add('refining')
    expect(entries.size).toBe(1)
    await shared.deleteItem(ref)
    expect(entries.has(ref)).toBe(false)
  })

  it('leaves tasks to the tracker, though their statuses share names with shared stations', async () => {
    const { shared, keys, calls } = setup()
    keys.set('T-9', { kind: 'task', key: 'todo' })
    const moved = await shared.transition('T-9', 'to-do', 'in-progress')
    expect(moved.status).toBe('in-progress')
    expect(calls).toEqual(['T-9 to-do → in-progress'])
  })

  it('does not ask the tracker’s doctor about moves inside a group', async () => {
    const { shared, doctored } = setup()
    await shared.doctor?.([
      { kind: 'item', from: 'refining', to: 'split-done' },
      { kind: 'item', from: 'split-done', to: 'in-progress' },
      { kind: 'task', from: 'to-do', to: 'in-progress' },
    ])
    expect(doctored).toEqual([
      [
        { kind: 'item', from: 'split-done', to: 'in-progress' },
        { kind: 'task', from: 'to-do', to: 'in-progress' },
      ],
    ])
  })
})
