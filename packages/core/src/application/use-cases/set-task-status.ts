import type { Run } from '../../domain/run'
import { agentMoveRefusal } from '../../domain/task'
import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { StoragePort } from '../ports/storage'
import { listTasks } from './list-tasks'

export interface SetTaskStatusInput {
  task: Ref
  status: string
  reason: string
}

// An executing agent moves one of its item's tasks. Every move leaves the reason on the
// task, so a person sees why without reading the log (D67).
export async function setTaskStatus(
  storage: StoragePort,
  run: Run,
  input: SetTaskStatusInput,
): Promise<WorkUnit> {
  const reason = input.reason.trim()
  if (reason === '') throw new InvalidInput('reason is empty')
  const tasks = await listTasks(storage, run.target)
  const task = tasks.find((t) => t.ref === input.task)
  if (task === undefined) throw new InvalidInput(`${input.task} is not a task of ${run.target}`)
  const refusal = agentMoveRefusal(task, input.status, tasks)
  if (refusal !== undefined) throw new InvalidInput(refusal)
  const moved = await storage.transition(task.ref, task.status, input.status)
  await storage.addComment({
    target: task.ref,
    author: 'engine',
    kind: 'system',
    body: `The agent moved it from ${task.status} to ${input.status}.\n\n${reason}`,
  })
  return moved
}
