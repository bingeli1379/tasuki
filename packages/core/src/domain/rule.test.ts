import { describe, expect, it } from 'vite-plus/test'
import { exitFor, outcomeOf, verdictsOf, type Rule } from './rule'

const split: Rule = {
  id: 'split',
  watch: 'ready-to-split',
  claim: 'splitting',
  agent: 'a',
  dispatch: false,
  needsFeedback: false,
  maxAttempts: 3,
  prompt: '',
  session: 'fresh',
  outcomes: { succeeded: 'split-review', needs_input: 'needs-answers' },
}

describe('exitFor', () => {
  it('follows the rule', () => {
    expect(exitFor(split, 'succeeded')).toBe('split-review')
    expect(exitFor(split, 'needs_input')).toBe('needs-answers')
  })

  it('has nothing for an outcome the rule does not cover', () => {
    expect(exitFor(split, 'blocked_manual')).toBeUndefined()
    expect(exitFor(split, 'constructor')).toBeUndefined()
  })
})

describe('verdictsOf', () => {
  it('is every outcome of the rule but max_attempts, which only the engine reaches', () => {
    expect(
      verdictsOf({ ...split, outcomes: { ...split.outcomes, failed: 'x', max_attempts: 'x' } }),
    ).toEqual(['succeeded', 'needs_input', 'failed'])
  })
})

describe('outcomeOf', () => {
  const clean = { code: 0, signal: null }

  it('takes the verdict of an agent that exited cleanly as it is, nothing checked (D109)', () => {
    expect(outcomeOf('succeeded', clean)).toEqual({ outcome: 'succeeded' })
    expect(outcomeOf('needs_input', clean)).toEqual({ outcome: 'needs_input' })
    expect(outcomeOf('done_for_now', clean)).toEqual({ outcome: 'done_for_now' })
  })

  it('is failed without a verdict', () => {
    expect(outcomeOf(undefined, clean)).toEqual({
      outcome: 'failed',
      reason: 'the agent reported no verdict',
    })
  })

  it('is failed on a non-zero exit or a kill, whatever the agent reported', () => {
    expect(outcomeOf('succeeded', { code: 2, signal: null })).toEqual({
      outcome: 'failed',
      reason: 'exit code 2',
    })
    expect(outcomeOf('succeeded', { code: null, signal: 'SIGKILL' })).toEqual({
      outcome: 'failed',
      reason: 'the agent was killed by SIGKILL',
    })
  })

  it('is needs_input when the runner ended an agent that kept being refused (D107)', () => {
    expect(
      outcomeOf('succeeded', { code: null, signal: 'SIGTERM', stoppedFor: 'refused' }),
    ).toEqual({
      outcome: 'needs_input',
      reason: 'refused',
    })
  })
})
