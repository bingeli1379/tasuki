// What the server sends back. Mirrors @tasuki/core's types for the fields the board uses.
export interface Item {
  ref: string
  title: string
  body: string
  status: string
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

export interface ItemDetail {
  item: Item
  comments: Comment[]
  attachments: Attachment[]
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
