import type { Outcome, Run, Verdict } from '../../domain/run'
import type { Ref } from '../../domain/work-unit'

export interface NewRun {
  target: Ref
  rule: string
  agent: string
  attempt: number
  workspace: string
  leaseSeconds: number
}

// The engine's own state, always a local sqlite. Not a plugin role (architecture.md).
// The store stamps every time from the Clock.
export interface RuntimeStorePort {
  // Throws RunConflict when the target already has a live Run (invariant 1).
  createRun(run: NewRun): Promise<Run>
  // Throws NotFound for an unknown id.
  getRun(id: string): Promise<Run>
  renewLease(id: string, leaseSeconds: number): Promise<void>
  // Keeps the first report; throws InvalidInput on a second one or once the Run is over.
  report(id: string, verdict: Verdict, summary: string): Promise<void>
  finishRun(id: string, outcome: Outcome): Promise<void>
  liveRuns(): Promise<Run[]>
  // Newest first.
  runsFor(target: Ref): Promise<Run[]>
}
