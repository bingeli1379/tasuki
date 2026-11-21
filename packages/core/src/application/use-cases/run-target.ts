import type { Run } from '../../domain/run'
import type { Ref } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { StoragePort } from '../ports/storage'

// An agent reaches its Run's item and that item's tasks, nothing else.
export async function assertRunTarget(storage: StoragePort, run: Run, target: Ref): Promise<void> {
  if (target !== run.target && !(await storage.children(run.target)).some((t) => t.ref === target))
    throw new InvalidInput(`${target} is not this run's item or one of its tasks`)
}
