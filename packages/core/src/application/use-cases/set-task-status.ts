import type { Run } from '../../domain/run'
import { taskStatusName as named } from '../../domain/workflow'
import { agentMoveRefusal } from '../../domain/task'
import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { TrackerPort } from '../ports/tracker'
import { listTasks } from './list-tasks'

export interface SetTaskStatusInput {
  task: Ref
  status: string
  reason: string
}

// An executing agent moves one of its item's tasks. Every move leaves the reason on the
// task, so a person sees why without reading the log (D67).
export async function setTaskStatus(
  tracker: TrackerPort,
  run: Run,
  input: SetTaskStatusInput,
): Promise<WorkUnit> {
  const reason = input.reason.trim()
  if (reason === '') throw new InvalidInput('reason is empty')
  const tasks = await listTasks(tracker, run.target)
  const task = tasks.find((t) => t.ref === input.task)
  if (task === undefined) throw new InvalidInput(`${input.task} is not a task of ${run.target}`)
  const refusal = agentMoveRefusal(task, input.status, tasks)
  if (refusal !== undefined) throw new InvalidInput(refusal)
  const moved = await tracker.transition(task.ref, task.status, input.status)
  await tracker.addComment({
    target: task.ref,
    author: 'engine',
    kind: 'system',
    body: `The agent moved it ${named(task.status)} → ${named(input.status)}.\n\n${reason}`,
  })
  return moved
}
