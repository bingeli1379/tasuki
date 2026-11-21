import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import { NotFound } from '../not-found'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'
import { updateItem, type UpdateItemInput } from './update-item'

// Tasks are fixed by hand only while the person reviews the split: before that the splitter
// is still making them, after it an agent may be working from them (D69). taskReview is the
// station that plays that part; without one, no task is ever changed by hand.
async function assertInTaskReview(
  storage: StoragePort,
  taskReview: string | undefined,
  ref: Ref,
): Promise<void> {
  const task = await storage.get(ref)
  if (task.kind !== 'task' || task.parent === undefined) throw new NotFound(`${ref} is not a task`)
  if (taskReview === undefined)
    throw new InvalidInput(`${ref} cannot be changed: no status has the taskReview role`)
  const item = await storage.get(task.parent)
  if (item.status !== taskReview)
    throw new InvalidInput(
      `${ref} can only be changed while ${item.ref} is in ${taskReview}; it is in ${item.status}`,
    )
}

export async function updateTask(
  storage: StoragePort,
  taskReview: string | undefined,
  input: UpdateItemInput,
): Promise<WorkUnit> {
  await assertInTaskReview(storage, taskReview, input.ref)
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

export async function deleteTask(
  storage: StoragePort,
  taskReview: string | undefined,
  ref: Ref,
): Promise<void> {
  await assertInTaskReview(storage, taskReview, ref)
  await storage.deleteTask(ref)
}
