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
  // Newest first, with the live Runs on its tasks in front when a dispatch rule runs them.
  runs: Run[]
}

export async function getItem(
  tracker: TrackerPort,
  store: StorePort,
  ref: Ref,
): Promise<ItemDetail> {
  // get first, so a missing ref is one NotFound rather than four.
  const item = await tracker.get(ref)
  const [comments, attachments, tasks, own, live] = await Promise.all([
    tracker.comments(ref),
    tracker.attachments(ref),
    listTasks(tracker, ref),
    store.runsFor(ref),
    store.liveRuns(),
  ])
  const onTasks = live.filter((r) => r.item === ref && r.target !== ref)
  return { item, comments, attachments, tasks, runs: [...onTasks, ...own] }
}
