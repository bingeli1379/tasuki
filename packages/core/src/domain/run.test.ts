import { describe, expect, it } from 'vite-plus/test'
import { nextAttempt, type Outcome, type Run } from './run'

const run = (attempt: number, outcome: Outcome): Run => ({
  id: 'r',
  target: 'X-1',
  rule: 'split',
  agent: 'a',
  attempt,
  workspace: '/w/X-1',
  state: 'finished',
  outcome,
  leaseUntil: '',
  startedAt: '',
  lastActivityAt: '',
  logPath: '',
})

describe('nextAttempt (D38)', () => {
  it('starts at 1 when the rule never ran on the item', () => {
    expect(nextAttempt(undefined)).toBe(1)
  })

  it('counts up only after an abandoned Run', () => {
    expect(nextAttempt(run(2, 'abandoned'))).toBe(3)
  })

  it.each<Outcome>(['succeeded', 'needs_input', 'blocked_manual', 'failed', 'cancelled'])(
    'starts over after %s: a person is in the loop, so there is no cap',
    (outcome) => {
      expect(nextAttempt(run(2, outcome))).toBe(1)
    },
  )

  it('starts over after max_attempts, so pulling the item back out of blocked resets it', () => {
    expect(nextAttempt(run(4, 'max_attempts'))).toBe(1)
  })
})
