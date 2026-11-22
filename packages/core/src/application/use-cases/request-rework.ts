import type { Ref, WorkUnit } from '../../domain/work-unit'
import type { Workflow } from '../../domain/workflow'
import { InvalidInput } from '../invalid-input'
import type { TrackerPort } from '../ports/tracker'
import { StatusConflict } from '../status-conflict'
import { moveItem } from './move-item'

export interface RequestReworkInput {
  ref: Ref
  // What the person saw, as in moveItem.
  from: string
  // What is wrong with the work. The reworking agent has nothing else to go on.
  feedback: string
}

// A person sends finished work back with what to fix, to the station with the rework role
// (state-machine.md, in-review to ready-to-rework).
export async function requestRework(
  tracker: TrackerPort,
  workflow: Workflow,
  input: RequestReworkInput,
): Promise<WorkUnit> {
  const { rework } = workflow.roles
  if (input.feedback.trim() === '') throw new InvalidInput('say what to rework: feedback is empty')
  if (rework === undefined) throw new InvalidInput('no status has the rework role')
  const item = await tracker.get(input.ref)
  if (item.status !== input.from) throw new StatusConflict(input.from, item)
  // The comment goes first: a rework rule may claim the item the moment it moves, and its
  // agent works from this comment.
  await tracker.addComment({
    target: input.ref,
    author: 'human',
    kind: 'note',
    body: input.feedback,
  })
  return moveItem(tracker, workflow, { ref: input.ref, from: input.from, to: rework })
}
