import type { Ref, WorkUnit } from '../../domain/work-unit'
import type { TrackerPort } from '../ports/tracker'

export interface TaskEntry extends WorkUnit {
  // Tasks of the same item this one waits for.
  blockedBy: Ref[]
}

// Oldest first.
export async function listTasks(tracker: TrackerPort, item: Ref): Promise<TaskEntry[]> {
  const [tasks, dependencies] = await Promise.all([
    tracker.children(item),
    tracker.dependencies(item),
  ])
  return tasks.map((t) => ({
    ...t,
    blockedBy: dependencies.filter((d) => d.task === t.ref).map((d) => d.blockedBy),
  }))
}
