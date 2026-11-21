import type { Comment } from '../../domain/comment'
import type { Run } from '../../domain/run'
import type { Ref } from '../../domain/work-unit'
import type { StoragePort } from '../ports/storage'
import { assertRunTarget } from './run-target'

// Oldest first. A reworking agent finds what the person wants changed here.
export async function listAgentComments(
  storage: StoragePort,
  run: Run,
  target: Ref,
): Promise<Comment[]> {
  await assertRunTarget(storage, run, target)
  return storage.comments(target)
}
