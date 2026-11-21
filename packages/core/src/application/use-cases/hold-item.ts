import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'
import { logAction } from './log-action'

export interface HoldDeps {
  storage: StoragePort
  runtime: RuntimeStorePort
}

async function assertItem(storage: StoragePort, ref: Ref): Promise<void> {
  if ((await storage.get(ref)).kind !== 'item')
    throw new InvalidInput(`${ref} is a task: only an item goes on hold`)
}

// A person tells the engine to keep off an item (invariant 5). A Run already on it is asked
// to wind down here and now; the Poller would also notice the label, a round later.
export async function holdItem(
  { storage, runtime }: HoldDeps,
  holdLabel: string,
  ref: Ref,
): Promise<WorkUnit> {
  await assertItem(storage, ref)
  const item = await storage.addLabel(ref, holdLabel)
  const live = (await runtime.liveRuns()).find((r) => r.target === ref)
  if (live !== undefined) await runtime.requestCancel(live.id, 'soft', 'hold')
  await logAction(storage, ref, 'Put on hold.')
  return item
}

// The engine may pick the item up again from the next round (stop-and-recovery.md).
export async function releaseItem(
  storage: StoragePort,
  holdLabel: string,
  ref: Ref,
): Promise<WorkUnit> {
  await assertItem(storage, ref)
  const item = await storage.removeLabel(ref, holdLabel)
  await logAction(storage, ref, 'Released from hold.')
  return item
}

// The Stop button: the Run on the item ends now. The item goes on hold first, or the round
// after the Run is gone would start a new one on it.
export async function stopRun(
  { storage, runtime }: HoldDeps,
  holdLabel: string,
  ref: Ref,
): Promise<WorkUnit> {
  const live = (await runtime.liveRuns()).find((r) => r.target === ref)
  if (live === undefined) throw new InvalidInput(`nothing is running on ${ref}`)
  const item = await storage.addLabel(ref, holdLabel)
  await runtime.requestCancel(live.id, 'hard', 'stop')
  await logAction(storage, ref, 'Stopped the agent and put on hold.')
  return item
}
