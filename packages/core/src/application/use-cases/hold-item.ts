import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { StorePort } from '../ports/store'
import type { TrackerPort } from '../ports/tracker'
import { taskStatusName as named } from '../../domain/workflow'
import { logAction } from './log-action'

export interface HoldDeps {
  tracker: TrackerPort
  store: StorePort
}

async function assertItem(tracker: TrackerPort, ref: Ref): Promise<void> {
  if ((await tracker.get(ref)).kind !== 'item')
    throw new InvalidInput(`${ref} is a task: only an item goes on hold`)
}

// A person tells the engine to keep off an item (invariant 5). A Run already on it is asked
// to wind down here and now; the Poller would also notice the label, a round later.
export async function holdItem(
  { tracker, store }: HoldDeps,
  holdLabel: string,
  ref: Ref,
): Promise<WorkUnit> {
  await assertItem(tracker, ref)
  const item = await tracker.addLabel(ref, holdLabel)
  // Every Run working for it: its own, or one per task a dispatch rule runs.
  for (const live of (await store.liveRuns()).filter((r) => r.item === ref))
    await store.requestCancel(live.id, 'soft', 'hold')
  await logAction(tracker, ref, 'Put on hold.')
  return item
}

// The engine may pick the item up again from the next round (stop-and-recovery.md).
export async function releaseItem(
  tracker: TrackerPort,
  holdLabel: string,
  ref: Ref,
): Promise<WorkUnit> {
  await assertItem(tracker, ref)
  const item = await tracker.removeLabel(ref, holdLabel)
  await logAction(tracker, ref, 'Released from hold.')
  return item
}

// The Stop button: the Runs on the item end now. The item goes on hold first, or the round
// after the Runs are gone would start new ones on it. On a task a dispatch rule runs, only
// that task's Run ends and the person takes the task over instead (D102).
export async function stopRun(
  { tracker, store }: HoldDeps,
  holdLabel: string,
  ref: Ref,
): Promise<WorkUnit> {
  const unit = await tracker.get(ref)
  const all = await store.liveRuns()
  if (unit.kind === 'task') {
    const live = all.find((r) => r.target === ref)
    if (live === undefined) throw new InvalidInput(`nothing is running on ${ref}`)
    await store.requestCancel(live.id, 'hard', 'stop')
    const task = await tracker.transition(ref, unit.status, 'manual')
    await logAction(
      tracker,
      ref,
      `Stopped the agent and took it over: ${named(unit.status)} → ${named('manual')}.`,
    )
    return task
  }
  const live = all.filter((r) => r.item === ref)
  if (live.length === 0) throw new InvalidInput(`nothing is running on ${ref}`)
  const item = await tracker.addLabel(ref, holdLabel)
  for (const run of live) await store.requestCancel(run.id, 'hard', 'stop')
  await logAction(tracker, ref, 'Stopped the agent and put on hold.')
  return item
}
