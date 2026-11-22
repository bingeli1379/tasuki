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
  // The item, or one of its tasks when a dispatch rule runs them one by one (D102).
  target: string
  rule: string
  attempt: number
  // Where the item was claimed from and where the engine moved it; older Runs have neither.
  from?: string
  to?: string
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
  // Newest first: the Runs a dispatch rule started on it.
  runs: Run[]
}

export interface ItemDetail {
  item: Item
  comments: Comment[]
  attachments: Attachment[]
  // Oldest first.
  tasks: Task[]
  // Newest first, the live ones on its tasks in front.
  runs: Run[]
}

export type Access = 'admin' | 'maintainer' | 'member'

export interface Account {
  userId: string
  username: string
  displayName: string
  access: Access
  disabled: boolean
  createdAt: string
  // Set once someone added from an outside system has signed in.
  externalId?: string
}

export interface AuthState {
  // none: nobody signs in; builtin: tasuki keeps the accounts; external: another system does.
  mode: 'none' | 'builtin' | 'external'
  needsSetup: boolean
  me?: Account
}

export interface ApiToken {
  id: string
  name: string
  expiresAt?: string
  createdAt: string
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
  // The session ended (its ttl, sign-out elsewhere, a disabled account): back to the sign-in
  // page. Not for signing in itself, whose 401 is a wrong password.
  if (res.status === 401 && !path.startsWith('/api/auth/')) location.reload()
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
