import type { Ref } from './work-unit'

// The name of one of the rule's outcomes, as the agent reported it (custom-workflow.md 3).
export type Verdict = string

// A verdict that passed the check, failed, or one only the engine reaches: max_attempts,
// cancelled and abandoned.
export type Outcome = string

export type CancelMode = 'soft' | 'hard'

// stop: the Stop button. hold: the item got the hold label. moved: a person moved the item
// out of the status the Run works in. pause: the engine was paused with every Run stopped.
export type CancelReason = 'stop' | 'hold' | 'moved' | 'pause'

export interface Run {
  id: string
  target: Ref
  rule: string
  agent: string
  attempt: number
  // The status the item was claimed from, and where the engine moved it when the Run ended.
  // Kept as they were then: the workflow may change later. Runs from before D82 have neither,
  // and to stays unset when the engine moved nothing (cancelled, abandoned).
  from?: string
  to?: string
  // The agent session this Run ran in, once the runner knows it.
  sessionId?: string
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
}

// D38: only a Run that died (abandoned) counts towards the next attempt. Anything else,
// max_attempts included, starts over at 1, which is how a person pulling the item back
// resets it without the engine having to watch who moved it.
export function nextAttempt(previous: Run | undefined): number {
  return previous?.outcome === 'abandoned' ? previous.attempt + 1 : 1
}
