import { describe, expect, it } from 'vite-plus/test'
import type { Rule } from '../../domain/rule'
import { storeStub } from '../../testing/store-stub'
import { InvalidInput } from '../invalid-input'
import { reportResult } from './report-result'

const review: Rule = {
  id: 'ai-review',
  watch: 'ai-review',
  agent: 'a',
  dispatch: false,
  needsFeedback: false,
  maxAttempts: 3,
  prompt: '',
  session: 'fresh',
  outcomes: {
    approve: 'in-review',
    changes: 'ready-to-rework',
    needs_input: 'blocked',
    failed: 'blocked',
    max_attempts: 'blocked',
  },
}

describe('reportResult', () => {
  it('records the verdict with the summary trimmed', async () => {
    const reported: unknown[] = []
    const store = storeStub({
      report: (...args) => (reported.push(args), Promise.resolve()),
    })
    await reportResult(store, 'r1', review, { verdict: 'approve', summary: ' Reads well. ' })
    expect(reported).toEqual([['r1', 'approve', 'Reads well.']])
  })

  it.each(['succeeded', 'in-review', 'max_attempts', 'cancelled'])(
    'refuses %s, which is not an outcome the agent of this rule can report',
    async (verdict) => {
      await expect(
        reportResult(storeStub({}), 'r1', review, { verdict, summary: 'Done.' }),
      ).rejects.toThrow('verdict must be one of approve, changes, needs_input, failed')
    },
  )

  it('refuses a blank summary, since it is the reason the item moves', async () => {
    await expect(
      reportResult(storeStub({}), 'r1', review, { verdict: 'failed', summary: ' ' }),
    ).rejects.toBeInstanceOf(InvalidInput)
  })
})
