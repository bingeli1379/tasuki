import type { Ref, WorkUnit } from '../../domain/work-unit'
import type { StoragePort } from '../ports/storage'

export interface TaskEntry extends WorkUnit {
  // Tasks of the same item this one waits for.
  blockedBy: Ref[]
}

// Oldest first.
export async function listTasks(storage: StoragePort, item: Ref): Promise<TaskEntry[]> {
  const [tasks, dependencies] = await Promise.all([
    storage.children(item),
    storage.dependencies(item),
  ])
  return tasks.map((t) => ({
    ...t,
    blockedBy: dependencies.filter((d) => d.task === t.ref).map((d) => d.blockedBy),
  }))
}
