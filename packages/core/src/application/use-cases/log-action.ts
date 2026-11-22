import type { Ref } from '../../domain/work-unit'
import type { TrackerPort } from '../ports/tracker'

// A person's button or MCP action leaves a line on the unit, so its comments say who did what
// when (D74). System, not note: an agent takes a person's latest note as their feedback.
export async function logAction(tracker: TrackerPort, target: Ref, body: string): Promise<void> {
  await tracker.addComment({ target, author: 'human', kind: 'system', body })
}
