import { personMoveRefusal } from '../../domain/task'
import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import { NotFound } from '../not-found'
import type { StoragePort } from '../ports/storage'

export interface MoveTaskInput {
  ref: Ref
  // What the person saw, so a move made on stale data is a StatusConflict.
  from: string
  to: string
}

// A person takes a task over, hands it back, or finishes it by hand. Taking over a task an
// agent is on is a soft stop: it is not dispatched again, but the one already running may
// finish it (state-machine.md, M1).
export async function moveTask(storage: StoragePort, input: MoveTaskInput): Promise<WorkUnit> {
  if ((await storage.get(input.ref)).kind !== 'task')
    throw new NotFound(`${input.ref} is not a task`)
  const refusal = personMoveRefusal(input.ref, input.from, input.to)
  if (refusal !== undefined) throw new InvalidInput(refusal)
  return storage.transition(input.ref, input.from, input.to)
}
