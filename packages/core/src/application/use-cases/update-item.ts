import type { Ref, WorkUnit } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { ItemPatch, TrackerPort } from '../ports/tracker'

export interface UpdateItemInput {
  ref: Ref
  // The version the person started editing from; a newer one means someone else saved.
  expectedVersion: string
  title?: string
  body?: string
}

export async function updateItem(tracker: TrackerPort, input: UpdateItemInput): Promise<WorkUnit> {
  const patch: ItemPatch = {}
  if (input.title !== undefined) {
    patch.title = input.title.trim()
    if (patch.title === '') throw new InvalidInput('title is required')
  }
  if (input.body !== undefined) patch.body = input.body
  if (patch.title === undefined && patch.body === undefined)
    throw new InvalidInput('nothing to update: give title or body')
  return tracker.updateItem(input.ref, input.expectedVersion, patch)
}
