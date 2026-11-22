import type { WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { TrackerPort } from '../ports/tracker'

export interface CreateItemInput {
  title: string
  body: string
}

export async function createItem(
  tracker: TrackerPort,
  entry: string,
  input: CreateItemInput,
): Promise<WorkUnit> {
  const title = input.title.trim()
  if (title === '') throw new InvalidInput('title is required')
  // Only humans create items, and every item starts at the entry station (state-machine.md).
  return tracker.createItem({ title, body: input.body, status: entry })
}
