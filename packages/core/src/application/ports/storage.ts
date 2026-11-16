import type { Kind, WorkUnit } from '../../domain/work-unit'

export interface NewItem {
  title: string
  body: string
  status: string
}

// Each call takes effect on its own; there is no transaction across calls (D47).
export interface StoragePort {
  list(kind: Kind, status: string): Promise<WorkUnit[]>
  createItem(item: NewItem): Promise<WorkUnit>
}
