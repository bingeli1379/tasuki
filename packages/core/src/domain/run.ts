import type { Ref } from './work-unit'

export type Verdict = 'succeeded' | 'needs_input' | 'blocked_manual' | 'failed'

export const VERDICTS: readonly Verdict[] = ['succeeded', 'needs_input', 'blocked_manual', 'failed']

// cancelled, max_attempts and abandoned only ever come from the engine.
export type Outcome = Verdict | 'max_attempts' | 'cancelled' | 'abandoned'

export type CancelMode = 'soft' | 'hard'

// stop: the Stop button. hold: the item got the hold label. moved: a person moved the item
// out of the status the Run works in.
export type CancelReason = 'stop' | 'hold' | 'moved'

export interface Run {
  id: string
  target: Ref
  rule: string
  agent: string
  attempt: number
  workspace: string
  state: 'running' | 'finished'
  outcome?: Outcome
  // What the agent reported with report_result, before the engine turns it into an outcome.
  verdict?: Verdict
  summary?: string
  // What the agent made through the facade during this Run; verdicts are checked against it.
  produced: { questions: number; tasks: number }
  // Set once a person asked it to stop (stop-and-recovery.md). soft only refuses the agent's
  // writes; hard also ends its process. A soft cancel can turn hard, never the other way.
  cancelRequestedAt?: string
  cancelMode?: CancelMode
  cancelRequestedBy?: CancelReason
  leaseUntil: string
  startedAt: string
  lastActivityAt: string
  finishedAt?: string
  logPath: string
}

// D38: only a Run that died (abandoned) counts towards the next attempt. Anything else,
// max_attempts included, starts over at 1, which is how a person pulling the item back
// resets it without the engine having to watch who moved it.
export function nextAttempt(previous: Run | undefined): number {
  return previous?.outcome === 'abandoned' ? previous.attempt + 1 : 1
}
