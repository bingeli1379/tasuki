import { describe, expect, it } from 'vite-plus/test'
import { exitFor, outcomeOf, verdictsOf, type Evidence, type Rule, type RuleMode } from './rule'
import type { Verdict } from './run'
import type { TaskNode } from './task'

const split: Rule = {
  id: 'split',
  watch: 'ready-to-split',
  claim: 'splitting',
  agent: 'a',
  mode: 'split',
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
  const task = (ref: string, status: string, blockedBy: string[] = []): TaskNode => ({
    ref,
    status,
    blockedBy,
  })
  const made = {
    tasks: [task('T-2', 'to-do'), task('T-3', 'to-do', ['T-2'])],
    produced: { tasks: 2, questions: 1 },
  }
  const none = { tasks: [], produced: { tasks: 0, questions: 0 } }

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

  // agent-contract.md, the verdict table: one row per check, passing and failing.
  it.each<[RuleMode, Verdict, Evidence, string | undefined]>([
    ['split', 'succeeded', { ...none, tasks: [task('T-2', 'manual')] }, undefined],
    ['split', 'succeeded', none, 'the agent reported succeeded but the item has no tasks'],
    ['rework', 'succeeded', { ...made, produced: { tasks: 1, questions: 0 } }, undefined],
    [
      'rework',
      'succeeded',
      { ...made, produced: { tasks: 0, questions: 0 } },
      'the agent reported succeeded but made no task in this run',
    ],
    [
      'execute',
      'succeeded',
      { ...none, tasks: [task('T-2', 'done'), task('T-3', 'done')] },
      undefined,
    ],
    [
      'execute',
      'succeeded',
      { ...none, tasks: [task('T-2', 'done'), task('T-3', 'manual')] },
      'the agent reported succeeded but 1 of 2 tasks are not done',
    ],
    ['split', 'needs_input', { ...none, produced: { tasks: 0, questions: 1 } }, undefined],
    ['execute', 'needs_input', none, 'the agent reported needs_input but asked no question'],
    // The manual task holds up the only to-do one.
    [
      'execute',
      'blocked_manual',
      { ...none, tasks: [task('T-2', 'manual'), task('T-3', 'to-do', ['T-2'])] },
      undefined,
    ],
    [
      'execute',
      'blocked_manual',
      { ...none, tasks: [task('T-2', 'done')] },
      'the agent reported blocked_manual but no task is manual',
    ],
    [
      'execute',
      'blocked_manual',
      { ...none, tasks: [task('T-2', 'manual'), task('T-3', 'to-do')] },
      'the agent reported blocked_manual but T-3 can still run',
    ],
    ['execute', 'failed', none, undefined],
    // What a rule declares on top of its mode's own is moved on unchecked.
    ['execute', 'needs_design', none, undefined],
    ['review', 'approve', none, undefined],
    // review has no succeeded of its own, so one a rule declares means only what it says.
    ['review', 'succeeded', none, undefined],
    ['review', 'needs_input', none, 'the agent reported needs_input but asked no question'],
  ])('%s %s: %j is %s', (mode, verdict, evidence, reason) => {
    expect(outcomeOf(mode, verdict, clean, evidence)).toEqual(
      reason === undefined ? { outcome: verdict } : { outcome: 'failed', reason },
    )
  })
})
