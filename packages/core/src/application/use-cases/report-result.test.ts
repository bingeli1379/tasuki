import { describe, expect, it } from 'vite-plus/test'
import { runtimeStub } from '../../testing/runtime-stub'
import { InvalidInput } from '../invalid-input'
import { reportResult } from './report-result'

describe('reportResult', () => {
  it('records the verdict with the summary trimmed', async () => {
    const reported: unknown[] = []
    const runtime = runtimeStub({
      report: (...args) => (reported.push(args), Promise.resolve()),
    })
    await reportResult(runtime, 'r1', { verdict: 'failed', summary: ' Tests do not build. ' })
    expect(reported).toEqual([['r1', 'failed', 'Tests do not build.']])
  })

  it('refuses a blank summary, since it is the reason the item moves', async () => {
    await expect(
      reportResult(runtimeStub({}), 'r1', { verdict: 'failed', summary: ' ' }),
    ).rejects.toBeInstanceOf(InvalidInput)
  })
})
