import type { Ref, WorkUnit } from '../domain/work-unit'
import type { StorePort } from './ports/store'
import type { TrackerPort } from './ports/tracker'
import type { StatusMap } from './status-map'
import { StatusConflict } from './status-conflict'

// Stations may share one tracker status (D104). The tracker reads any of them back as the
// first of the group; the store keeps which one an item is really in, and a move inside the
// group never reaches the tracker. Task statuses are never shared.
export function withSharedStatuses(
  tracker: TrackerPort,
  store: StorePort,
  statuses: StatusMap,
): TrackerPort {
  const key = (status: string): string => statuses.toTracker('item', status)
  const sameKey = (a: string, b: string): boolean => {
    const mapped = statuses.mapped('item')
    return mapped.includes(a) && mapped.includes(b) && key(a) === key(b)
  }
  const shared = (status: string): boolean =>
    statuses.mapped('item').some((other) => other !== status && sameKey(other, status))
  // The first of a group goes unrecorded, so an item nobody moved inside it needs no entry.
  const entryFor = (status: string): string | undefined =>
    statuses.fromTracker('item', key(status)) === status ? undefined : status

  const resolve = async (units: WorkUnit[]): Promise<WorkUnit[]> => {
    const items = units.filter((u) => u.kind === 'item')
    if (items.length === 0) return units
    const entries = await store.itemStatuses(items.map((u) => u.ref))
    const resolved: WorkUnit[] = []
    for (const unit of units) {
      const entry = unit.kind === 'item' ? entries[unit.ref] : undefined
      if (entry === undefined) resolved.push(unit)
      else if (sameKey(entry, unit.status)) resolved.push({ ...unit, status: entry })
      else {
        // Moved off the group in the tracker, or a station the flow dropped: the tracker wins,
        // and the entry goes now so that moving it back does not bring the old station back.
        await store.setItemStatus(unit.ref, entry, undefined)
        resolved.push(unit)
      }
    }
    return resolved
  }
  const one = async (unit: WorkUnit): Promise<WorkUnit> => (await resolve([unit]))[0] ?? unit

  const forget = async (ref: Ref): Promise<void> => {
    const entry = (await store.itemStatuses([ref]))[ref]
    if (entry !== undefined) await store.setItemStatus(ref, entry, undefined)
  }

  const wrapped: Partial<TrackerPort> = {
    list: async (kind, wanted) => {
      const units = await tracker.list(kind, wanted)
      if (kind === 'task') return units
      return (await resolve(units)).filter((u) => wanted.includes(u.status))
    },
    get: async (ref) => one(await tracker.get(ref)),
    createItem: async (item) => {
      const created = await tracker.createItem(item)
      const entry = entryFor(item.status)
      if (entry === undefined) return created
      await store.setItemStatus(created.ref, undefined, entry)
      return { ...created, status: entry }
    },
    transition: async (ref, expectedFrom, to) => {
      const plain = !shared(expectedFrom) && !shared(to)
      if (plain) return one(await tracker.transition(ref, expectedFrom, to))
      const unit = await one(await tracker.get(ref))
      if (unit.kind === 'task') return tracker.transition(ref, expectedFrom, to)
      // The tracker's own compare-and-set sees only the group, not the station in it.
      if (unit.status !== expectedFrom) throw new StatusConflict(expectedFrom, unit)
      const before = entryFor(expectedFrom)
      const after = entryFor(to)
      if (sameKey(expectedFrom, to)) {
        if (!(await store.setItemStatus(ref, before, after)))
          throw new StatusConflict(expectedFrom, await one(await tracker.get(ref)))
        return { ...unit, status: to }
      }
      const moved = await tracker.transition(ref, expectedFrom, to)
      if (before !== after) await store.setItemStatus(ref, before, after)
      return one(moved)
    },
    updateItem: async (ref, expectedVersion, patch) =>
      one(await tracker.updateItem(ref, expectedVersion, patch)),
    deleteItem: async (ref) => {
      await tracker.deleteItem(ref)
      await forget(ref)
    },
    addLabel: async (ref, label) => one(await tracker.addLabel(ref, label)),
    removeLabel: async (ref, label) => one(await tracker.removeLabel(ref, label)),
  }
  if (tracker.doctor !== undefined)
    // A move inside a group is not a move in the tracker.
    wrapped.doctor = async (transitions) =>
      (await tracker.doctor?.(
        transitions.filter((t) => t.kind === 'task' || !sameKey(t.from, t.to)),
      )) ?? []
  return Object.assign(Object.create(tracker) as TrackerPort, wrapped)
}
