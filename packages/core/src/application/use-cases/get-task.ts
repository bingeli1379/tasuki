import type { Comment } from '../../domain/comment'
import type { Run } from '../../domain/run'
import type { Ref } from '../../domain/work-unit'
import { NotFound } from '../not-found'
import type { StorePort } from '../ports/store'
import type { TrackerPort } from '../ports/tracker'
import { listTasks, type TaskEntry } from './list-tasks'

export interface TaskDetail {
  task: TaskEntry
  // Oldest first, the reasons the engine and its agents left for each move among them (D67).
  comments: Comment[]
  // Newest first: the Runs a dispatch rule started on this task.
  runs: Run[]
}

export async function getTask(
  tracker: TrackerPort,
  store: StorePort,
  ref: Ref,
): Promise<TaskDetail> {
  const unit = await tracker.get(ref)
  if (unit.kind !== 'task' || unit.parent === undefined) throw new NotFound(`${ref} is not a task`)
  const [tasks, comments, runs] = await Promise.all([
    listTasks(tracker, unit.parent),
    tracker.comments(ref),
    store.runsFor(ref),
  ])
  return { task: tasks.find((t) => t.ref === ref) ?? { ...unit, blockedBy: [] }, comments, runs }
}
