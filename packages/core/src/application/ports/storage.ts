import type { Attachment } from '../../domain/attachment'
import type { Comment, CommentAuthor, CommentKind } from '../../domain/comment'
import type { Dependency, Kind, Origin, Ref, WorkUnit } from '../../domain/work-unit'

export interface NewItem {
  title: string
  body: string
  status: string
}

export interface NewTask {
  title: string
  body: string
  status: string
  origin: Origin
  // Tasks of the same item this one waits for.
  blockedBy: Ref[]
}

export interface ItemPatch {
  title?: string
  body?: string
}

export interface NewComment {
  target: Ref
  author: CommentAuthor
  kind: CommentKind
  body: string
}

export interface NewAttachment {
  filename: string
  mimeType: string
  data: Uint8Array
}

// Each call takes effect on its own; there is no transaction across calls (D47).
export interface StoragePort {
  // May lag behind writes by a few seconds: Jira serves it from a search index.
  // Callers that just wrote must use what the write returned, not re-list.
  // Every unit in any of the statuses, oldest first, in one query: Jira rate-limits per call.
  list(kind: Kind, statuses: readonly string[]): Promise<WorkUnit[]>
  // Throws NotFound when the tracker has no such unit.
  get(ref: Ref): Promise<WorkUnit>
  // The item's tasks, oldest first. Unlike list, sees a task the moment it is created: a
  // verdict is checked against it right after the agent made it.
  children(item: Ref): Promise<WorkUnit[]>
  // Between the item's tasks. Same freshness as children.
  dependencies(item: Ref): Promise<Dependency[]>
  createItem(item: NewItem): Promise<WorkUnit>
  // Throws NotFound when item is not an item, InvalidInput when a blockedBy ref is not one
  // of its tasks. The task and its dependencies are separate writes (D47).
  createTask(item: Ref, task: NewTask): Promise<WorkUnit>
  // Compare-and-set: throws StatusConflict when the unit is not in expectedFrom, NotFound
  // when it does not exist. Returns the unit after the move.
  transition(ref: Ref, expectedFrom: string, to: string): Promise<WorkUnit>
  // Throws EditConflict when the unit is no longer at expectedVersion. Fields left out
  // of the patch are not written at all.
  updateItem(ref: Ref, expectedVersion: string, patch: ItemPatch): Promise<WorkUnit>
  // Removes the task with its dependencies either way, comments and attachments; a task that
  // waited for it no longer does. Its ref is never handed out again. Throws NotFound when ref
  // is not a task.
  deleteTask(ref: Ref): Promise<void>
  // Removes the item with all its tasks, as deleteTask would each, and its own comments and
  // attachments. Throws NotFound when ref is not an item.
  deleteItem(ref: Ref): Promise<void>
  // Adding a label the unit has, or removing one it lacks, changes nothing; neither touches
  // the version. Only that one label is written, so a label someone else set meanwhile stays.
  // Throws NotFound when ref does not exist. Returns the unit after the change.
  addLabel(ref: Ref, label: string): Promise<WorkUnit>
  removeLabel(ref: Ref, label: string): Promise<WorkUnit>
  // Oldest first.
  comments(target: Ref): Promise<Comment[]>
  addComment(comment: NewComment): Promise<Comment>
  attachments(target: Ref): Promise<Attachment[]>
  addAttachment(target: Ref, attachment: NewAttachment): Promise<Attachment>
  // Throws NotFound when the id is not an attachment of target.
  readAttachment(target: Ref, id: string): Promise<{ attachment: Attachment; data: Uint8Array }>
  // Throws NotFound when the id is not an attachment of target. Does not touch the version.
  deleteAttachment(target: Ref, id: string): Promise<void>
}
