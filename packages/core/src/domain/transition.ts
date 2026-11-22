import { exitFor, runningStatus, type Rule } from './rule'
import { AGENT_MOVES } from './task'
import type { Kind } from './work-unit'

// A move between two logical statuses, which a tracker with a workflow may not allow.
export interface Transition {
  kind: Kind
  from: string
  to: string
}

// Every move the rules make the engine or an agent ask of the tracker (doctor, check 8).
// A person's moves are left out: the board lets anyone go anywhere and the tracker refuses
// what its workflow does not allow at the time.
export function ruleTransitions(rules: readonly Rule[]): Transition[] {
  const found = new Map<string, Transition>()
  const add = (kind: Kind, from: string, to: string): void => {
    if (from !== to) found.set(`${kind} ${from} ${to}`, { kind, from, to })
  }
  for (const rule of rules) {
    if (rule.claim !== undefined) {
      add('item', rule.watch, rule.claim)
      // Recovery and a released hold send it back.
      add('item', rule.claim, rule.watch)
    }
    for (const to of Object.values(rule.outcomes)) add('item', runningStatus(rule), to)
    // Giving up happens before a claim, and so does a rework with no feedback (D75).
    const gaveUp = exitFor(rule, 'max_attempts')
    if (gaveUp !== undefined) add('item', rule.watch, gaveUp)
    const asked = exitFor(rule, 'needs_input')
    if (rule.mode === 'rework' && asked !== undefined) add('item', rule.watch, asked)
    const parked = exitFor(rule, 'blocked_manual')
    if (parked !== undefined) add('item', parked, rule.watch)
    if (rule.mode === 'execute' || rule.mode === 'custom')
      for (const [from, targets] of Object.entries(AGENT_MOVES))
        for (const to of targets) add('task', from, to)
  }
  return [...found.values()]
}
