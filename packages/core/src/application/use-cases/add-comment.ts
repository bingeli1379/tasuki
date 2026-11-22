import type { Comment } from '../../domain/comment'
import type { Ref } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { TrackerPort } from '../ports/tracker'

export interface AddCommentInput {
  ref: Ref
  body: string
}

// A person's comment. Questions and system notes come from agents and the engine only.
export async function addComment(tracker: TrackerPort, input: AddCommentInput): Promise<Comment> {
  if (input.body.trim() === '') throw new InvalidInput('comment is empty')
  await tracker.get(input.ref)
  return tracker.addComment({ target: input.ref, author: 'human', kind: 'note', body: input.body })
}
