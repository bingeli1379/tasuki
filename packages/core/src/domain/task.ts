import type { Ref } from './work-unit'

// What the task rules need to know about one task of an item.
export interface TaskNode {
  ref: Ref
  status: string
  // Tasks of the same item it waits for.
  blockedBy: readonly Ref[]
}

// A to-do task whose blockers are all done: the next thing an agent can start.
export const isRunnable = (task: TaskNode, all: readonly TaskNode[]): boolean =>
  task.status === 'to-do' &&
  task.blockedBy.every((b) => all.find((t) => t.ref === b)?.status === 'done')

// The task diagram in state-machine.md, as the agent may walk it. Only a person moves a
// task out of manual, and done is final (invariant 4).
const AGENT_MOVES: Readonly<Record<string, readonly string[]>> = {
  'to-do': ['in-progress', 'manual'],
  'in-progress': ['in-review', 'to-do', 'manual'],
  'in-review': ['done', 'in-progress'],
}

// Why the agent may not move this task there, or undefined when it may.
export function agentMoveRefusal(
  task: TaskNode,
  to: string,
  all: readonly TaskNode[],
): string | undefined {
  if (task.status === 'done') return `${task.ref} is done; done tasks are never reopened`
  if (task.status === 'manual') return `${task.ref} is manual; only a person moves it out`
  if (!(AGENT_MOVES[task.status] ?? []).includes(to))
    return `${task.ref} cannot go from ${task.status} to ${to}`
  if (to === 'in-progress' && task.status === 'to-do' && !isRunnable(task, all))
    return `${task.ref} waits for tasks that are not done`
  return undefined
}

// The person's edges of the task diagram: take a task over, hand it back, finish it by hand,
// and undo a done by mistake. The engine never reopens a done task (invariant 4); a person
// may, while no Run is on the item (D74).
const PERSON_MOVES: Readonly<Record<string, readonly string[]>> = {
  'to-do': ['manual'],
  'in-progress': ['manual'],
  manual: ['done', 'to-do'],
  done: ['to-do', 'manual'],
}

// Why a person may not move a task from `from` to `to`, or undefined when they may.
export function personMoveRefusal(ref: Ref, from: string, to: string): string | undefined {
  if (!(PERSON_MOVES[from] ?? []).includes(to)) return `${ref} cannot go from ${from} to ${to}`
  return undefined
}
