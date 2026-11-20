import type { Ref } from './work-unit'

export type Verdict = 'succeeded' | 'needs_input' | 'blocked_manual' | 'failed'

export const VERDICTS: readonly Verdict[] = ['succeeded', 'needs_input', 'blocked_manual', 'failed']

// cancelled, max_attempts and abandoned only ever come from the engine.
export type Outcome = Verdict | 'max_attempts' | 'cancelled' | 'abandoned'

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
