import type { Outcome, Verdict } from './run'
import { isRunnable, type TaskNode } from './task'

export type RuleMode = 'split' | 'execute' | 'rework'

// fresh: every Run starts a new agent session. per-item: a Run picks up the newest session
// this agent had on the item (data-model.md).
export type RuleSession = 'fresh' | 'per-item'

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
  // The template given to the agent, before its variables are filled in.
  prompt: string
  session: RuleSession
}

// The variables a prompt template can use (config-and-rules.md). Ticket content stays out:
// a person wrote it and it may carry instructions, so the agent reads it through the facade.
export function expandPrompt(
  template: string,
  vars: { ref: string; runId: string; workspace: string; mode: RuleMode },
): string {
  const values: Record<string, string> = {
    'item.ref': vars.ref,
    'run.id': vars.runId,
    workspace: vars.workspace,
    mode: vars.mode,
  }
  return template.replace(/\{\{\s*([a-z.]+)\s*\}\}/g, (all, name: string) => values[name] ?? all)
}

// Config fills in failed and max_attempts with the failure station when a rule leaves them out.
export function exitFor(rule: Rule, outcome: RuleExit): string | undefined {
  return rule.on[outcome]
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
  tasks: readonly TaskNode[]
  // What this Run made.
  produced: { tasks: number; questions: number }
}

// The agent's verdict is a claim; the engine checks it before acting on it
// (agent-contract.md, the verdict table).
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
  const refusal = refuse(mode, verdict, evidence)
  return refusal === undefined ? { outcome: verdict } : { outcome: 'failed', reason: refusal }
}

function refuse(
  mode: RuleMode,
  verdict: Verdict,
  { tasks, produced }: Evidence,
): string | undefined {
  const claim = `the agent reported ${verdict}`
  switch (verdict) {
    case 'succeeded': {
      if (mode === 'split' && tasks.length === 0) return `${claim} but the item has no tasks`
      if (mode === 'rework' && produced.tasks === 0) return `${claim} but made no task in this run`
      const open = tasks.filter((t) => t.status !== 'done').length
      if (mode === 'execute' && open > 0)
        return `${claim} but ${open} of ${tasks.length} tasks are not done`
      return undefined
    }
    case 'needs_input':
      return produced.questions === 0 ? `${claim} but asked no question` : undefined
    case 'blocked_manual': {
      if (!tasks.some((t) => t.status === 'manual')) return `${claim} but no task is manual`
      const runnable = tasks.find((t) => isRunnable(t, tasks))
      return runnable !== undefined ? `${claim} but ${runnable.ref} can still run` : undefined
    }
    case 'failed':
      return undefined
  }
}
