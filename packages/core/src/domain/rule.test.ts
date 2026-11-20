import { describe, expect, it } from 'vite-plus/test'
import { exitFor, outcomeOf, type Rule } from './rule'

const split: Rule = {
  id: 'split',
  watch: 'ready-to-split',
  claim: 'splitting',
  agent: 'a',
  mode: 'split',
  maxAttempts: 3,
  on: { succeeded: 'split-review', needs_input: 'needs-answers' },
}

describe('exitFor', () => {
  it('follows the rule', () => {
    expect(exitFor(split, 'succeeded')).toBe('split-review')
    expect(exitFor(split, 'needs_input')).toBe('needs-answers')
  })

  it('failed and max_attempts go to blocked unless the rule says otherwise', () => {
    expect(exitFor(split, 'failed')).toBe('blocked')
    expect(exitFor(split, 'max_attempts')).toBe('blocked')
    expect(exitFor({ ...split, on: { failed: 'refining' } }, 'failed')).toBe('refining')
  })

  it('has nothing for an outcome the rule does not cover', () => {
    expect(exitFor(split, 'blocked_manual')).toBeUndefined()
  })
})

describe('outcomeOf', () => {
  const clean = { code: 0, signal: null }

  it('takes the verdict of an agent that exited cleanly', () => {
    expect(outcomeOf('needs_input', clean)).toEqual({ outcome: 'needs_input' })
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
})
