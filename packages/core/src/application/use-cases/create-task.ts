import type { Run } from '../../domain/run'
import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { StorePort } from '../ports/store'
import type { TrackerPort } from '../ports/tracker'

export interface CreateTaskDeps {
  tracker: TrackerPort
  store: StorePort
}

export interface CreateTaskInput {
  title: string
  body: string
  // to-do for the engine to run, manual for a step a person has to do.
  status: string
  blockedBy: Ref[]
}

const INITIAL = ['to-do', 'manual']

// A splitting agent adds a task to the item its Run works on.
export async function createTask(
  { tracker, store }: CreateTaskDeps,
  run: Run,
  input: CreateTaskInput,
): Promise<WorkUnit> {
  if (input.title.trim() === '') throw new InvalidInput('title is empty')
  if (!INITIAL.includes(input.status))
    throw new InvalidInput(`a new task starts in ${INITIAL.join(' or ')}`)
  const task = await tracker.createTask(run.target, {
    title: input.title.trim(),
    body: input.body,
    status: input.status,
    origin: 'splitter',
    blockedBy: input.blockedBy,
  })
  await store.bumpProduced(run.id, 'tasks')
  return task
}
