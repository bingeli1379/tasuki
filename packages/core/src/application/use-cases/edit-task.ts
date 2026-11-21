import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import { NotFound } from '../not-found'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'
import { updateItem, type UpdateItemInput } from './update-item'

// Tasks are fixed by hand only while the person reviews the split: before that the splitter
// is still making them, after it an agent may be working from them (D69).
async function assertInSplitReview(storage: StoragePort, ref: Ref): Promise<void> {
  const task = await storage.get(ref)
  if (task.kind !== 'task' || task.parent === undefined) throw new NotFound(`${ref} is not a task`)
  const item = await storage.get(task.parent)
  if (item.status !== 'split-review')
    throw new InvalidInput(
      `${ref} can only be changed while ${item.ref} is in split-review; it is in ${item.status}`,
    )
}

export async function updateTask(storage: StoragePort, input: UpdateItemInput): Promise<WorkUnit> {
  await assertInSplitReview(storage, input.ref)
  return updateItem(storage, input)
}

// An item with an agent on it is not deleted: stop it first. Its Runs stay in the runtime
// store as history.
export async function deleteItem(
  { storage, runtime }: { storage: StoragePort; runtime: RuntimeStorePort },
  ref: Ref,
): Promise<void> {
  if ((await runtime.liveRuns()).some((r) => r.target === ref))
    throw new InvalidInput(`an agent is working on ${ref}; stop it before deleting`)
  await storage.deleteItem(ref)
}

export async function deleteTask(storage: StoragePort, ref: Ref): Promise<void> {
  await assertInSplitReview(storage, ref)
  await storage.deleteTask(ref)
}
