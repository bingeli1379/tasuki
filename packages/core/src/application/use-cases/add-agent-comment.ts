import type { Comment } from '../../domain/comment'
import type { Run } from '../../domain/run'
import type { Ref } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'
import { assertRunTarget } from './run-target'

export interface AddAgentCommentDeps {
  storage: StoragePort
  runtime: RuntimeStorePort
}

export interface AddAgentCommentInput {
  // The Run's item or one of its tasks.
  target: Ref
  kind: 'note' | 'question'
  body: string
}

// A question is what a needs_input verdict is checked against, so it is counted on the Run.
export async function addAgentComment(
  { storage, runtime }: AddAgentCommentDeps,
  run: Run,
  input: AddAgentCommentInput,
): Promise<Comment> {
  if (input.body.trim() === '') throw new InvalidInput('comment is empty')
  await assertRunTarget(storage, run, input.target)
  const comment = await storage.addComment({
    target: input.target,
    author: 'agent',
    kind: input.kind,
    body: input.body,
  })
  if (input.kind === 'question') await runtime.bumpProduced(run.id, 'questions')
  return comment
}
