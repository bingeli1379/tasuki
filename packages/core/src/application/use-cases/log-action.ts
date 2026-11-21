import type { Ref } from '../../domain/work-unit'
import type { StoragePort } from '../ports/storage'

// A person's button or MCP action leaves a line on the unit, so its comments say who did what
// when (D74). System, not note: an agent takes a person's latest note as their feedback.
export async function logAction(storage: StoragePort, target: Ref, body: string): Promise<void> {
  await storage.addComment({ target, author: 'human', kind: 'system', body })
}
