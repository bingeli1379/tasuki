import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { StoragePort } from '../ports/storage'

export interface MoveItemInput {
  ref: Ref
  from: string
  to: string
}

// A person moves an item: any status to any status (state-machine.md), as long as the
// config maps the target. `from` is what the person saw, so a move made on stale data
// fails with StatusConflict instead of overwriting someone else's.
export async function moveItem(
  storage: StoragePort,
  mapped: readonly string[],
  input: MoveItemInput,
): Promise<WorkUnit> {
  for (const status of [input.from, input.to])
    if (!mapped.includes(status)) throw new InvalidInput(`status "${status}" is not on the board`)
  if (input.from === input.to) throw new InvalidInput(`${input.ref} is already in ${input.to}`)
  return storage.transition(input.ref, input.from, input.to)
}
