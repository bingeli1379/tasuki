import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { StorePort } from '../ports/store'
import type { TrackerPort } from '../ports/tracker'
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
  const live = (await store.liveRuns()).find((r) => r.target === ref)
  if (live !== undefined) await store.requestCancel(live.id, 'soft', 'hold')
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

// The Stop button: the Run on the item ends now. The item goes on hold first, or the round
// after the Run is gone would start a new one on it.
export async function stopRun(
  { tracker, store }: HoldDeps,
  holdLabel: string,
  ref: Ref,
): Promise<WorkUnit> {
  const live = (await store.liveRuns()).find((r) => r.target === ref)
  if (live === undefined) throw new InvalidInput(`nothing is running on ${ref}`)
  const item = await tracker.addLabel(ref, holdLabel)
  await store.requestCancel(live.id, 'hard', 'stop')
  await logAction(tracker, ref, 'Stopped the agent and put on hold.')
  return item
}
