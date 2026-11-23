import type { Denial, Outcome, Verdict } from './run'

// What every rule declares: where a finished item goes (D109). Only the engine reaches
// blocked_manual on a dispatch rule, from the tasks (D102).
export const REQUIRED_OUTCOMES: readonly string[] = ['succeeded']
export const DISPATCH_OUTCOMES: readonly string[] = ['succeeded', 'blocked_manual']

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
  // The engine runs the item's tasks itself, one Run per task by the dependency graph, and
  // picks the item's exit from them; the agent works one task (D102, D109).
  dispatch: boolean
  // A person's feedback has to be on the item before it runs, and the board asks for it when
  // sending an item back here (D75, D86, D109).
  needsFeedback: boolean
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
  vars: { ref: string; task?: string; runId: string; workspace: string },
): string {
  const values: Record<string, string> = {
    'item.ref': vars.ref,
    'task.ref': vars.task ?? '',
    'run.id': vars.runId,
    workspace: vars.workspace,
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
  rule.dispatch
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

// The agent's verdict is taken as it is: no rule's outcome is checked (D109).
export function outcomeOf(
  verdict: Verdict | undefined,
  exit: RunExit,
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
  return { outcome: verdict }
}
