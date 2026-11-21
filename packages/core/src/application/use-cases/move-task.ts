import { personMoveRefusal } from '../../domain/task'
import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import { NotFound } from '../not-found'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'
import { taskStatusName as named } from '../../domain/workflow'
import { logAction } from './log-action'

export interface MoveTaskDeps {
  storage: StoragePort
  runtime: RuntimeStorePort
}

export interface MoveTaskInput {
  ref: Ref
  // What the person saw, so a move made on stale data is a StatusConflict.
  from: string
  to: string
}

// A person takes a task over, hands it back, or finishes it by hand. Taking over a task an
// agent is on is a soft stop: it is not dispatched again, but the one already running may
// finish it (state-machine.md, M1).
// Reopening a done task waits until no Run is on the item: its agent may be counting on it.
export async function moveTask(
  { storage, runtime }: MoveTaskDeps,
  input: MoveTaskInput,
): Promise<WorkUnit> {
  const task = await storage.get(input.ref)
  if (task.kind !== 'task') throw new NotFound(`${input.ref} is not a task`)
  const refusal = personMoveRefusal(input.ref, input.from, input.to)
  if (refusal !== undefined) throw new InvalidInput(refusal)
  if (input.from === 'done' && (await runtime.liveRuns()).some((r) => r.target === task.parent))
    throw new InvalidInput(
      `an agent is working on ${task.parent}; reopen ${input.ref} once it is done`,
    )
  const moved = await storage.transition(input.ref, input.from, input.to)
  await logAction(storage, input.ref, `Moved ${named(input.from)} → ${named(input.to)}.`)
  return moved
}
