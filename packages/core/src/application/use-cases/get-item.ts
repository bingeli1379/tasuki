import type { Attachment } from '../../domain/attachment'
import type { Comment } from '../../domain/comment'
import type { Run } from '../../domain/run'
import type { Ref, WorkUnit } from '../../domain/work-unit'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'
import { listTasks, type TaskEntry } from './list-tasks'

export interface ItemDetail {
  item: WorkUnit
  comments: Comment[]
  attachments: Attachment[]
  // Oldest first.
  tasks: TaskEntry[]
  // Newest first.
  runs: Run[]
}

export async function getItem(
  storage: StoragePort,
  runtime: RuntimeStorePort,
  ref: Ref,
): Promise<ItemDetail> {
  // get first, so a missing ref is one NotFound rather than four.
  const item = await storage.get(ref)
  const [comments, attachments, tasks, runs] = await Promise.all([
    storage.comments(ref),
    storage.attachments(ref),
    listTasks(storage, ref),
    runtime.runsFor(ref),
  ])
  return { item, comments, attachments, tasks, runs }
}
