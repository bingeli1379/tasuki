import type { Comment } from '../../domain/comment'
import type { Run } from '../../domain/run'
import type { Ref } from '../../domain/work-unit'
import type { TrackerPort } from '../ports/tracker'
import { assertRunTarget } from './run-target'

// Oldest first. A reworking agent finds what the person wants changed here.
export async function listAgentComments(
  tracker: TrackerPort,
  run: Run,
  target: Ref,
): Promise<Comment[]> {
  await assertRunTarget(tracker, run, target)
  return tracker.comments(target)
}
