import type { Comment } from '../../domain/comment'
import type { Ref } from '../../domain/work-unit'
import { NotFound } from '../not-found'
import type { StoragePort } from '../ports/storage'
import { listTasks, type TaskEntry } from './list-tasks'

export interface TaskDetail {
  task: TaskEntry
  // Oldest first, the reasons the engine and its agents left for each move among them (D67).
  comments: Comment[]
}

export async function getTask(storage: StoragePort, ref: Ref): Promise<TaskDetail> {
  const unit = await storage.get(ref)
  if (unit.kind !== 'task' || unit.parent === undefined) throw new NotFound(`${ref} is not a task`)
  const [tasks, comments] = await Promise.all([
    listTasks(storage, unit.parent),
    storage.comments(ref),
  ])
  return { task: tasks.find((t) => t.ref === ref) ?? { ...unit, blockedBy: [] }, comments }
}
