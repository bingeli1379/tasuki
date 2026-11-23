import type { Account } from '../../domain/account'
import type { Kind } from '../../domain/work-unit'
import { Forbidden } from '../forbidden'
import { InvalidInput } from '../invalid-input'
import type { SettingsVersion, StorePort } from '../ports/store'
import type { TrackerPort } from '../ports/tracker'
import type { StatusMapping } from '../status-map'

const KINDS: readonly Kind[] = ['item', 'task']

export function assertEditsFlow(actor: Account): void {
  if (actor.access === 'member') throw new Forbidden('only an admin or a maintainer edits the flow')
}

// Per kind, the statuses keyed to something the tracker does not hold. A tracker that takes
// any key has none.
async function unheld(
  tracker: TrackerPort,
  mapping: StatusMapping,
): Promise<Record<Kind, string[]>> {
  const found: Record<Kind, string[]> = { item: [], task: [] }
  if (tracker.listStatuses === undefined) return found
  for (const kind of KINDS) {
    const held = new Set((await tracker.listStatuses(kind)).map((s) => s.key))
    for (const [status, key] of Object.entries(mapping[kind] ?? {}))
      if (!held.has(key)) found[kind].push(status)
  }
  return found
}

// The same, as a person reads it: "task manual" for a task status.
export async function unmatchedStatuses(
  tracker: TrackerPort,
  mapping: StatusMapping,
): Promise<string[]> {
  const { item, task } = await unheld(tracker, mapping)
  return [...item, ...task.map((s) => `task ${s}`)]
}

// Units sitting in a status the new mapping drops or keys elsewhere: the board would lose
// them. Read through the tracker's current mapping, so call it before switching over. A
// status the tracker does not hold has nobody in it, and asking for it would be an error
// (Jira refuses a search for a status it does not know), as on the first save after Jira
// starts on the default flow.
async function stranded(
  tracker: TrackerPort,
  before: StatusMapping,
  after: StatusMapping,
): Promise<string[]> {
  const empty = await unheld(tracker, before)
  const found: string[] = []
  // Of stations sharing a key, items in the first are not recorded (D104): once another
  // station becomes first, they would all show up there.
  const firstOf = (mapping: StatusMapping, kind: Kind, key: string): string | undefined =>
    Object.entries(mapping[kind] ?? {}).find(([, k]) => k === key)?.[0]
  for (const kind of KINDS) {
    const gone = Object.entries(before[kind] ?? {})
      .filter(
        ([status, key]) =>
          (after[kind]?.[status] !== key ||
            (firstOf(before, kind, key) === status && firstOf(after, kind, key) !== status)) &&
          !empty[kind].includes(status),
      )
      .map(([status]) => status)
    if (gone.length > 0)
      for (const unit of await tracker.list(kind, gone)) found.push(`${unit.ref} (${unit.status})`)
  }
  return found
}

export interface FlowChange {
  // The version the editor started from, undefined when nothing was saved yet.
  expected: number | undefined
  flow: unknown
  // What the change maps each status to, already checked as a flow.
  mapping: StatusMapping
}

export async function saveFlow(
  deps: { tracker: TrackerPort; store: StorePort },
  actor: Account,
  current: StatusMapping,
  change: FlowChange,
): Promise<SettingsVersion> {
  assertEditsFlow(actor)
  const unmatched = await unmatchedStatuses(deps.tracker, change.mapping)
  if (unmatched.length > 0)
    throw new InvalidInput(`not a status in the tracker: ${unmatched.join(', ')}`)
  const left = await stranded(deps.tracker, current, change.mapping)
  if (left.length > 0)
    throw new InvalidInput(
      `move these off the statuses removed, rekeyed or no longer first of a shared key: ${left.join(', ')}`,
    )
  return deps.store.saveSettings('flow', change.expected, change.flow, actor.displayName)
}
