import type { CancelMode, CancelReason, Outcome, Run, Verdict } from '../../domain/run'
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
  // Counts what the agent made, for checking its verdict later.
  bumpProduced(id: string, key: 'questions' | 'tasks'): Promise<void>
  finishRun(id: string, outcome: Outcome): Promise<void>
  // Only on a live Run. The first request's time and reason stay; a later hard one turns a
  // soft cancel hard, and nothing turns it back.
  requestCancel(id: string, mode: CancelMode, by: CancelReason): Promise<void>
  liveRuns(): Promise<Run[]>
  // Newest first.
  runsFor(target: Ref): Promise<Run[]>
  // The newest Run of each target, where that Run ended in outcome.
  latestRunsEndedIn(outcome: Outcome): Promise<Run[]>
}
