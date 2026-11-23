import type { Denial, Outcome, Verdict } from './run'
import { isRunnable, type TaskNode } from './task'

// custom: every tool, nothing checked, the prompt alone says what to do; it still has to say
// where a finished item goes (D92).
// dispatch: the engine walks the task graph itself, one Run per task (M2, D102).
export type RuleMode = 'split' | 'execute' | 'dispatch' | 'rework' | 'review' | 'custom'

// What each mode itself means by an outcome, so the engine checks it before acting on it
// (agent-contract.md). Every other outcome a rule declares is moved on as it is.
export const MODE_OUTCOMES: Record<RuleMode, readonly string[]> = {
  split: ['succeeded'],
  execute: ['succeeded', 'blocked_manual'],
  // Reached by the engine reading the tasks, never reported by an agent.
  dispatch: ['succeeded', 'blocked_manual'],
  rework: ['succeeded'],
  review: [],
  custom: ['succeeded'],
}

// The outcomes every rule has without declaring them: config sends them to the failure
// station unless the rule says otherwise.
export const ENGINE_OUTCOMES: readonly string[] = ['needs_input', 'failed', 'max_attempts']

// fresh: every Run starts a new agent session. per-item: a Run picks up the newest session
// this agent had on the item (data-model.md).
export type RuleSession = 'fresh' | 'per-item'

export interface Rule {
  id: string
  watch: string
  // Where a claimed item waits while the Run works. Without one, only the lease dedupes.
  claim?: string
  agent: string
  mode: RuleMode
  maxAttempts: number
  // Outcome name to the status the item moves to. cancelled leaves it where it is;
  // abandoned is recovery's business, so neither is ever in here.
  outcomes: Record<string, string>
  // The template given to the agent, before its variables are filled in.
  prompt: string
  session: RuleSession
}

// The variables a prompt template can use (config-and-rules.md). Ticket content stays out:
// a person wrote it and it may carry instructions, so the agent reads it through the facade.
export function expandPrompt(
  template: string,
  vars: { ref: string; task?: string; runId: string; workspace: string; mode: RuleMode },
): string {
  const values: Record<string, string> = {
    'item.ref': vars.ref,
    'task.ref': vars.task ?? '',
    'run.id': vars.runId,
    workspace: vars.workspace,
    mode: vars.mode,
  }
  return template.replace(/\{\{\s*([a-z.]+)\s*\}\}/g, (all, name: string) => values[name] ?? all)
}

export function exitFor(rule: Rule, outcome: Outcome): string | undefined {
  return Object.hasOwn(rule.outcomes, outcome) ? rule.outcomes[outcome] : undefined
}

// What a dispatch worker reports about its one task; the rule's outcomes are the item's.
export const WORKER_VERDICTS: readonly string[] = ['succeeded', 'needs_input', 'failed']

// What the agent may report: every outcome of the rule but the one only the engine reaches.
export const verdictsOf = (rule: Rule): string[] =>
  rule.mode === 'dispatch'
    ? [...WORKER_VERDICTS]
    : Object.keys(rule.outcomes).filter((o) => o !== 'max_attempts')

// The status the item is in while its Run is alive.
export const runningStatus = (rule: Rule): string => rule.claim ?? rule.watch

export interface RunExit {
  code: number | null
  signal: string | null
  // What the CLI refused the agent, read from its own record when it exited (D107).
  denials?: Denial[]
  // Set when the runner ended the agent itself, saying why: it kept being refused with nobody
  // to ask (D107). The item goes to needs_input with this as the question.
  stoppedFor?: string
}

// What the engine looked up to check a verdict.
export interface Evidence {
  // Tasks under the item now, made by this Run or earlier (D30).
  tasks: readonly TaskNode[]
  // What this Run made.
  produced: { tasks: number; questions: number }
}

// The agent's verdict is a claim; the engine checks the ones it knows the meaning of before
// acting on it (agent-contract.md, the verdict table).
export function outcomeOf(
  mode: RuleMode,
  verdict: Verdict | undefined,
  exit: RunExit,
  evidence: Evidence,
): { outcome: Outcome; reason?: string } {
  if (exit.stoppedFor !== undefined) return { outcome: 'needs_input', reason: exit.stoppedFor }
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
  // Whoever picked custom answers for its verdicts, needs_input included (D92).
  if (mode === 'custom') return undefined
  if (verdict !== 'needs_input' && !MODE_OUTCOMES[mode].includes(verdict)) return undefined
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
    default:
      return undefined
  }
}
