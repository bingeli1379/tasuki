import type { Kind, Ref, WorkUnit } from '../../domain/work-unit'

export interface NewItem {
  title: string
  body: string
  status: string
}

// Each call takes effect on its own; there is no transaction across calls (D47).
export interface StoragePort {
  // May lag behind writes by a few seconds: Jira serves it from a search index.
  // Callers that just wrote must use what the write returned, not re-list.
  list(kind: Kind, status: string): Promise<WorkUnit[]>
  // Throws NotFound when the tracker has no such unit.
  get(ref: Ref): Promise<WorkUnit>
  createItem(item: NewItem): Promise<WorkUnit>
  // Compare-and-set: throws StatusConflict when the unit is not in expectedFrom, NotFound
  // when it does not exist. Returns the unit after the move.
  transition(ref: Ref, expectedFrom: string, to: string): Promise<WorkUnit>
}
