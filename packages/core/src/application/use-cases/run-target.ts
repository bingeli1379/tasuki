import type { Run } from '../../domain/run'
import type { Ref } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { TrackerPort } from '../ports/tracker'

// An agent reaches its Run's item and that item's tasks, nothing else. A dispatched task's
// worker reaches the same: its task is one of them.
export async function assertRunTarget(tracker: TrackerPort, run: Run, target: Ref): Promise<void> {
  if (target !== run.item && !(await tracker.children(run.item)).some((t) => t.ref === target))
    throw new InvalidInput(`${target} is not this run's item or one of its tasks`)
}
