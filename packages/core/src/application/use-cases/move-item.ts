import type { Ref, WorkUnit } from '../../domain/work-unit'
import { itemStatusNames, type Workflow } from '../../domain/workflow'
import { InvalidInput } from '../invalid-input'
import type { TrackerPort } from '../ports/tracker'
import { logAction } from './log-action'

export interface MoveItemInput {
  ref: Ref
  from: string
  to: string
}

// A person moves an item: any status to any status (state-machine.md), as long as the
// workflow lists the target. `from` is what the person saw, so a move made on stale data
// fails with StatusConflict instead of overwriting someone else's.
export async function moveItem(
  tracker: TrackerPort,
  workflow: Workflow,
  input: MoveItemInput,
): Promise<WorkUnit> {
  for (const status of [input.from, input.to])
    if (!workflow.statuses.some((s) => s.id === status))
      throw new InvalidInput(`status "${status}" is not on the board`)
  if (input.from === input.to) throw new InvalidInput(`${input.ref} is already in ${input.to}`)
  const moved = await tracker.transition(input.ref, input.from, input.to)
  const named = itemStatusNames(workflow)
  await logAction(tracker, input.ref, `Moved ${named(input.from)} → ${named(input.to)}.`)
  return moved
}
