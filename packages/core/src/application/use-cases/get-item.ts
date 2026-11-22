import type { Attachment } from '../../domain/attachment'
import type { Comment } from '../../domain/comment'
import type { Run } from '../../domain/run'
import type { Ref, WorkUnit } from '../../domain/work-unit'
import type { StorePort } from '../ports/store'
import type { TrackerPort } from '../ports/tracker'
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
  tracker: TrackerPort,
  store: StorePort,
  ref: Ref,
): Promise<ItemDetail> {
  // get first, so a missing ref is one NotFound rather than four.
  const item = await tracker.get(ref)
  const [comments, attachments, tasks, runs] = await Promise.all([
    tracker.comments(ref),
    tracker.attachments(ref),
    listTasks(tracker, ref),
    store.runsFor(ref),
  ])
  return { item, comments, attachments, tasks, runs }
}
