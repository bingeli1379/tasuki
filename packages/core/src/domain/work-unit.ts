export type Kind = 'item' | 'task'

// Opaque tracker key, e.g. "PROJ-123". The domain never parses it.
export type Ref = string

export type Origin = 'refine' | 'splitter' | 'human'

export interface WorkUnit {
  ref: Ref
  kind: Kind
  // Tasks only: the item they belong to. One level, never deeper.
  parent?: Ref
  title: string
  body: string
  status: string
  assignee?: string
  labels: string[]
  // Tasks only.
  origin?: Origin
  // Opaque; changes when title, body or status does, not on comments or attachments.
  // An edit carries the version it started from (EditConflict).
  version: string
}

// A task that cannot start before another one is done. Both are tasks of the same item.
export interface Dependency {
  task: Ref
  blockedBy: Ref
}
