// What the server sends back. Mirrors @tasuki/core's types for the fields the board uses.
export interface Item {
  ref: string
  title: string
  body: string
  status: string
  labels: string[]
  version: string
}

export interface Comment {
  id: string
  author: 'human' | 'agent' | 'engine'
  authorName?: string
  kind: 'note' | 'question' | 'system'
  body: string
  createdAt: string
}

export interface Attachment {
  id: string
  filename: string
  mimeType: string
  size: number
}

export interface Run {
  id: string
  rule: string
  attempt: number
  state: 'running' | 'finished'
  outcome?: string
  // Set once a person asked it to stop; hard ends the agent within seconds.
  cancelMode?: 'soft' | 'hard'
  startedAt: string
  finishedAt?: string
}

export interface Task {
  ref: string
  title: string
  status: string
  origin?: 'refine' | 'splitter' | 'human'
  // Refs of tasks it waits for.
  blockedBy: string[]
}

export interface TaskDetail {
  task: Task & { parent: string; body: string; version: string }
  // Oldest first; the engine's say why it or an agent moved the task.
  comments: Comment[]
}

export interface ItemDetail {
  item: Item
  comments: Comment[]
  attachments: Attachment[]
  // Oldest first.
  tasks: Task[]
  // Newest first.
  runs: Run[]
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly data: { error?: string; item?: Item },
  ) {
    super(data.error ?? `HTTP ${status}`)
  }
}

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const data: unknown = await res.json()
  if (!res.ok) throw new ApiError(res.status, data as { error?: string })
  return data as T
}

export const sendJson = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const attachmentUrl = (ref: string, id: string): string =>
  `/api/items/${encodeURIComponent(ref)}/attachments/${encodeURIComponent(id)}`

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
