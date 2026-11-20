// The target already has a live Run (invariant 1).
export class RunConflict extends Error {
  override name = 'RunConflict'
}
