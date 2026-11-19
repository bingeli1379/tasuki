import type { WorkUnit } from '../domain/work-unit'

// A compare-and-set transition found the unit somewhere other than expectedFrom.
// Carries the unit as it is now, so the caller can show where it went.
export class StatusConflict extends Error {
  override name = 'StatusConflict'
  readonly current: WorkUnit

  constructor(expectedFrom: string, current: WorkUnit) {
    super(`${current.ref} is in ${current.status}, not ${expectedFrom}`)
    this.current = current
  }
}
