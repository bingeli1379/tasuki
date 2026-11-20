import type { Ref } from './work-unit'

export interface Attachment {
  id: string
  target: Ref
  filename: string
  mimeType: string
  size: number
  createdAt: string
}

// Markdown refers to an attachment of the same work unit as ![alt](attachment:<id>).
// Each tracker maps it to its own way of embedding a file.
export const ATTACHMENT_SCHEME = 'attachment:'

export const MAX_ATTACHMENT_BYTES: number = 10 * 1024 * 1024
