import type { Attachment } from '../../domain/attachment'
import type { Comment } from '../../domain/comment'
import type { Run } from '../../domain/run'
import type { Ref, WorkUnit } from '../../domain/work-unit'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'

export interface ItemDetail {
  item: WorkUnit
  comments: Comment[]
  attachments: Attachment[]
  // Newest first.
  runs: Run[]
}

export async function getItem(
  storage: StoragePort,
  runtime: RuntimeStorePort,
  ref: Ref,
): Promise<ItemDetail> {
  // get first, so a missing ref is one NotFound rather than three.
  const item = await storage.get(ref)
  const [comments, attachments, runs] = await Promise.all([
    storage.comments(ref),
    storage.attachments(ref),
    runtime.runsFor(ref),
  ])
  return { item, comments, attachments, runs }
}
