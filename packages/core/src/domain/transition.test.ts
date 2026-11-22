import { describe, expect, it } from 'vite-plus/test'
import type { Rule } from './rule'
import { ruleTransitions } from './transition'

const rule = (patch: Partial<Rule>): Rule => ({
  id: 'r',
  watch: 'ready-to-split',
  agent: 'a',
  mode: 'split',
  maxAttempts: 3,
  outcomes: {
    succeeded: 'split-review',
    needs_input: 'needs-answers',
    failed: 'blocked',
    max_attempts: 'blocked',
  },
  prompt: '',
  session: 'fresh',
  ...patch,
})

const moves = (rules: Rule[]): string[] =>
  ruleTransitions(rules).map((t) => `${t.kind} ${t.from} -> ${t.to}`)

describe('ruleTransitions', () => {
  it('lists each exit of a rule without a claim from its watch status, once', () => {
    expect(moves([rule({})]).sort()).toEqual([
      'item ready-to-split -> blocked',
      'item ready-to-split -> needs-answers',
      'item ready-to-split -> split-review',
    ])
  })

  it('with a claim, moves in and back, exits from the claim, gives up from the watch', () => {
    expect(moves([rule({ claim: 'splitting' })]).sort()).toEqual([
      'item ready-to-split -> blocked',
      'item ready-to-split -> splitting',
      'item splitting -> blocked',
      'item splitting -> needs-answers',
      'item splitting -> ready-to-split',
      'item splitting -> split-review',
    ])
  })

  it('a rework with a claim asks for feedback from its watch status', () => {
    const rework = rule({ mode: 'rework', watch: 'ready-to-rework', claim: 'splitting' })
    expect(moves([rework])).toContain('item ready-to-rework -> needs-answers')
  })

  it('resumes from the blocked_manual exit, and an executing rule walks the task moves', () => {
    const execute = rule({
      mode: 'execute',
      watch: 'in-progress',
      outcomes: {
        succeeded: 'in-review',
        blocked_manual: 'blocked',
        needs_input: 'blocked',
        failed: 'blocked',
        max_attempts: 'blocked',
      },
    })
    const listed = moves([execute])
    expect(listed).toContain('item blocked -> in-progress')
    expect(listed.filter((m) => m.startsWith('task')).sort()).toEqual([
      'task in-progress -> in-review',
      'task in-progress -> manual',
      'task in-progress -> to-do',
      'task in-review -> done',
      'task in-review -> in-progress',
      'task to-do -> in-progress',
      'task to-do -> manual',
    ])
    expect(moves([rule({})]).some((m) => m.startsWith('task'))).toBe(false)
  })

  it('a dispatch rule claims a task, moves it by the verdict, and gives up on it (D102)', () => {
    const dispatch = rule({
      mode: 'dispatch',
      watch: 'in-progress',
      outcomes: { succeeded: 'in-review', blocked_manual: 'blocked' },
    })
    expect(
      moves([dispatch])
        .filter((m) => m.startsWith('task'))
        .sort(),
    ).toEqual([
      'task in-progress -> done',
      'task in-progress -> manual',
      'task in-progress -> to-do',
      'task to-do -> in-progress',
      'task to-do -> manual',
    ])
  })
})
