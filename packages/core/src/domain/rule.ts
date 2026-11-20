import type { Outcome, Verdict } from './run'

export type RuleMode = 'split' | 'execute' | 'rework'

// The outcomes a rule moves the item on. cancelled leaves it where it is; abandoned is
// recovery's business.
export type RuleExit = Exclude<Outcome, 'cancelled' | 'abandoned'>

export interface Rule {
  id: string
  watch: string
  // Where a claimed item waits while the Run works. Without one, only the lease dedupes.
  claim?: string
  agent: string
  mode: RuleMode
  maxAttempts: number
  on: Partial<Record<RuleExit, string>>
}

export function exitFor(rule: Rule, outcome: RuleExit): string | undefined {
  return (
    rule.on[outcome] ?? (outcome === 'failed' || outcome === 'max_attempts' ? 'blocked' : undefined)
  )
}

// The status the item is in while its Run is alive.
export const runningStatus = (rule: Rule): string => rule.claim ?? rule.watch

export interface RunExit {
  code: number | null
  signal: string | null
}

// Verdicts are taken as reported for now: checking them against the tasks needs tasks (S5).
export function outcomeOf(
  verdict: Verdict | undefined,
  exit: RunExit,
): { outcome: Verdict; reason?: string } {
  if (exit.code !== 0)
    return {
      outcome: 'failed',
      reason:
        exit.code !== null
          ? `exit code ${exit.code}`
          : exit.signal !== null
            ? `the agent was killed by ${exit.signal}`
            : 'the agent could not be started',
    }
  if (verdict === undefined) return { outcome: 'failed', reason: 'the agent reported no verdict' }
  return { outcome: verdict }
}
