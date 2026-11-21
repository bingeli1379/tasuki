import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { StoragePort } from '../ports/storage'
import { StatusConflict } from '../status-conflict'
import { moveItem } from './move-item'

export interface RequestReworkInput {
  ref: Ref
  // What the person saw, as in moveItem.
  from: string
  // What is wrong with the work. The reworking agent has nothing else to go on.
  feedback: string
}

// A person sends finished work back with what to fix (state-machine.md, in-review to
// ready-to-rework).
export async function requestRework(
  storage: StoragePort,
  mapped: readonly string[],
  input: RequestReworkInput,
): Promise<WorkUnit> {
  if (input.feedback.trim() === '') throw new InvalidInput('say what to rework: feedback is empty')
  if (!mapped.includes('ready-to-rework'))
    throw new InvalidInput('status "ready-to-rework" is not on the board')
  const item = await storage.get(input.ref)
  if (item.status !== input.from) throw new StatusConflict(input.from, item)
  // The comment goes first: a rework rule may claim the item the moment it moves, and its
  // agent works from this comment.
  await storage.addComment({
    target: input.ref,
    author: 'human',
    kind: 'note',
    body: input.feedback,
  })
  return moveItem(storage, mapped, { ref: input.ref, from: input.from, to: 'ready-to-rework' })
}
