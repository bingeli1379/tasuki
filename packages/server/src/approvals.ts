import { Forbidden, NotFound, type Account, type Clock, type Ref } from '@tasuki/core'
import { randomUUID } from 'node:crypto'

// A tool call an agent's CLI asks a person about before running it (D107). Kept in the
// engine's memory, like the Run tokens: the agent waiting on it lives in this process, so a
// restart loses both together.
export interface Approval {
  id: string
  runId: string
  item: Ref
  agent: string
  tool: string
  input: unknown
  askedAt: string
}

// What the CLI is told: run the call as it was asked, or not, with why.
export type Answer =
  | { behavior: 'allow'; updatedInput: unknown }
  | { behavior: 'deny'; message: string }

// allow-always also adds the call to the agent's own list, so it is not asked again.
export type Decision = 'allow' | 'allow-always' | 'deny'

export interface Approvals {
  // Resolves once a person answers, or with a deny when the Run ends first. signal: the CLI
  // stopped waiting, so the request is taken off the board.
  ask(request: Omit<Approval, 'id' | 'askedAt'>, signal?: AbortSignal): Promise<Answer>
  pending(): Approval[]
  answer(actor: Account, id: string, decision: Decision): Promise<Approval>
  // The Run is over: whatever it still waits on is denied.
  drop(runId: string): void
}

const DENIED = 'A person denied this. Do not try it another way; report needs_input and ask.'

// allowAlways adds the call to the agent's allowed tools; only an admin edits an agent (D107).
export function createApprovals(
  clock: Clock,
  allowAlways: (actor: Account, approval: Approval) => Promise<void>,
): Approvals {
  const waiting = new Map<string, { approval: Approval; settle: (answer: Answer) => void }>()
  return {
    ask(request, signal) {
      const approval = { ...request, id: randomUUID(), askedAt: clock.now().toISOString() }
      return new Promise<Answer>((resolve) => {
        const settle = (answer: Answer): void => {
          waiting.delete(approval.id)
          resolve(answer)
        }
        waiting.set(approval.id, { approval, settle })
        signal?.addEventListener('abort', () =>
          settle({ behavior: 'deny', message: 'Nobody answered in time.' }),
        )
      })
    },
    pending: () => [...waiting.values()].map((w) => w.approval),
    async answer(actor, id, decision) {
      const held = waiting.get(id)
      if (held === undefined)
        throw new NotFound(`no request ${id} is waiting: it was answered, or its run ended`)
      if (decision === 'allow-always') {
        if (actor.access !== 'admin')
          throw new Forbidden('only an admin changes what an agent may do; allow it once instead')
        await allowAlways(actor, held.approval)
      }
      held.settle(
        decision === 'deny'
          ? { behavior: 'deny', message: DENIED }
          : { behavior: 'allow', updatedInput: held.approval.input },
      )
      return held.approval
    },
    drop(runId) {
      for (const { approval, settle } of waiting.values())
        if (approval.runId === runId) settle({ behavior: 'deny', message: 'The run is over.' })
    },
  }
}
