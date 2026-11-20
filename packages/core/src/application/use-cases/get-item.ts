import type { Attachment } from '../../domain/attachment'
import type { Comment } from '../../domain/comment'
import type { Ref, WorkUnit } from '../../domain/work-unit'
import type { StoragePort } from '../ports/storage'

export interface ItemDetail {
  item: WorkUnit
  comments: Comment[]
  attachments: Attachment[]
}

export async function getItem(storage: StoragePort, ref: Ref): Promise<ItemDetail> {
  // get first, so a missing ref is one NotFound rather than three.
  const item = await storage.get(ref)
  const [comments, attachments] = await Promise.all([
    storage.comments(ref),
    storage.attachments(ref),
  ])
  return { item, comments, attachments }
}
