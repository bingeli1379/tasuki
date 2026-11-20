import type { WorkUnit } from '../domain/work-unit'

// An edit started from a version someone has since replaced. Carries the unit as it is now.
export class EditConflict extends Error {
  override name = 'EditConflict'
  readonly current: WorkUnit

  constructor(current: WorkUnit) {
    super(`${current.ref} was changed by someone else`)
    this.current = current
  }
}
