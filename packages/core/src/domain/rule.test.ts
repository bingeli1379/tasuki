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
  const made = { tasks: 2, questions: 1 }
  const none = { tasks: 0, questions: 0 }

  it('takes the verdict of an agent that exited cleanly and did what it claims', () => {
    expect(outcomeOf('split', 'succeeded', clean, made)).toEqual({ outcome: 'succeeded' })
    expect(outcomeOf('split', 'needs_input', clean, made)).toEqual({ outcome: 'needs_input' })
  })

  it('is failed without a verdict', () => {
    expect(outcomeOf('split', undefined, clean, made)).toEqual({
      outcome: 'failed',
      reason: 'the agent reported no verdict',
    })
  })

  it('is failed on a non-zero exit or a kill, whatever the agent reported', () => {
    expect(outcomeOf('split', 'succeeded', { code: 2, signal: null }, made)).toEqual({
      outcome: 'failed',
      reason: 'exit code 2',
    })
    expect(outcomeOf('split', 'succeeded', { code: null, signal: 'SIGKILL' }, made)).toEqual({
      outcome: 'failed',
      reason: 'the agent was killed by SIGKILL',
    })
  })

  // agent-contract.md, the verdict table.
  it('is failed when a split succeeded but the item has no tasks', () => {
    expect(outcomeOf('split', 'succeeded', clean, { tasks: 0, questions: 1 })).toEqual({
      outcome: 'failed',
      reason: 'the agent reported succeeded but the item has no tasks',
    })
  })

  it('is failed when the agent needs input but asked nothing', () => {
    expect(outcomeOf('split', 'needs_input', clean, { tasks: 2, questions: 0 })).toEqual({
      outcome: 'failed',
      reason: 'the agent reported needs_input but asked no question',
    })
  })

  it('takes failed as it is, with nothing to check', () => {
    expect(outcomeOf('split', 'failed', clean, none)).toEqual({ outcome: 'failed' })
  })
})
