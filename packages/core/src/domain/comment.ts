import type { Ref } from './work-unit'

export type CommentAuthor = 'human' | 'agent' | 'engine'
export type CommentKind = 'note' | 'question' | 'system'

export interface Comment {
  id: string
  target: Ref
  author: CommentAuthor
  // Who the tracker says wrote it, when it knows. Not set for comments written before login exists.
  authorName?: string
  kind: CommentKind
  body: string
  createdAt: string
}
