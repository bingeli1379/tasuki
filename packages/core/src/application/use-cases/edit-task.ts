import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import { NotFound } from '../not-found'
import type { StorePort } from '../ports/store'
import type { TrackerPort } from '../ports/tracker'
import { updateItem, type UpdateItemInput } from './update-item'

interface Deps {
  tracker: TrackerPort
  store: StorePort
}

// A person changes tasks by hand only while no agent works on their item: a splitter may
// still be making them, an executor working from them (D86). Stop the agent first.
async function assertNoAgent({ tracker, store }: Deps, ref: Ref): Promise<void> {
  const task = await tracker.get(ref)
  if (task.kind !== 'task' || task.parent === undefined) throw new NotFound(`${ref} is not a task`)
  const item = task.parent
  if ((await store.liveRuns()).some((r) => r.target === item))
    throw new InvalidInput(`an agent is working on ${item}; stop it before changing ${ref}`)
}

export async function updateTask(deps: Deps, input: UpdateItemInput): Promise<WorkUnit> {
  await assertNoAgent(deps, input.ref)
  return updateItem(deps.tracker, input)
}

// An item with an agent on it is not deleted: stop it first. Its Runs stay in the store
// store as history.
export async function deleteItem({ tracker, store }: Deps, ref: Ref): Promise<void> {
  if ((await store.liveRuns()).some((r) => r.target === ref))
    throw new InvalidInput(`an agent is working on ${ref}; stop it before deleting`)
  await tracker.deleteItem(ref)
}

export async function deleteTask(deps: Deps, ref: Ref): Promise<void> {
  await assertNoAgent(deps, ref)
  await deps.tracker.deleteTask(ref)
}
