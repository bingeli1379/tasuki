import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import { NotFound } from '../not-found'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'
import { updateItem, type UpdateItemInput } from './update-item'

interface Deps {
  storage: StoragePort
  runtime: RuntimeStorePort
}

// A person changes tasks by hand only while no agent works on their item: a splitter may
// still be making them, an executor working from them (D86). Stop the agent first.
async function assertNoAgent({ storage, runtime }: Deps, ref: Ref): Promise<void> {
  const task = await storage.get(ref)
  if (task.kind !== 'task' || task.parent === undefined) throw new NotFound(`${ref} is not a task`)
  const item = task.parent
  if ((await runtime.liveRuns()).some((r) => r.target === item))
    throw new InvalidInput(`an agent is working on ${item}; stop it before changing ${ref}`)
}

export async function updateTask(deps: Deps, input: UpdateItemInput): Promise<WorkUnit> {
  await assertNoAgent(deps, input.ref)
  return updateItem(deps.storage, input)
}

// An item with an agent on it is not deleted: stop it first. Its Runs stay in the runtime
// store as history.
export async function deleteItem({ storage, runtime }: Deps, ref: Ref): Promise<void> {
  if ((await runtime.liveRuns()).some((r) => r.target === ref))
    throw new InvalidInput(`an agent is working on ${ref}; stop it before deleting`)
  await storage.deleteItem(ref)
}

export async function deleteTask(deps: Deps, ref: Ref): Promise<void> {
  await assertNoAgent(deps, ref)
  await deps.storage.deleteTask(ref)
}
