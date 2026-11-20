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

// What the engine looked up to check a verdict.
export interface Evidence {
  // Tasks under the item now, made by this Run or earlier (D30).
  tasks: number
  // Questions this Run left.
  questions: number
}

// The agent's verdict is a claim; the engine checks it before acting on it
// (agent-contract.md). Execute, rework and blocked_manual checks arrive with the slices that
// run them; until then those verdicts are taken as reported.
export function outcomeOf(
  mode: RuleMode,
  verdict: Verdict | undefined,
  exit: RunExit,
  evidence: Evidence,
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
  if (mode === 'split' && verdict === 'succeeded' && evidence.tasks === 0)
    return { outcome: 'failed', reason: 'the agent reported succeeded but the item has no tasks' }
  if (verdict === 'needs_input' && evidence.questions === 0)
    return { outcome: 'failed', reason: 'the agent reported needs_input but asked no question' }
  return { outcome: verdict }
}
