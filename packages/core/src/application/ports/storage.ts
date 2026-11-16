import type { Kind, WorkUnit } from '../../domain/work-unit'

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
  createItem(item: NewItem): Promise<WorkUnit>
}
