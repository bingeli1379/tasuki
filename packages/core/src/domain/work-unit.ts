export type Kind = 'item' | 'task'

// Opaque tracker key, e.g. "PROJ-123". The domain never parses it.
export type Ref = string

export interface WorkUnit {
  ref: Ref
  kind: Kind
  parent?: Ref
  title: string
  body: string
  status: string
  assignee?: string
  labels: string[]
  origin?: 'refine' | 'splitter' | 'human'
  // Opaque; changes when title, body or status does, not on comments or attachments.
  // An edit carries the version it started from (EditConflict).
  version: string
}
