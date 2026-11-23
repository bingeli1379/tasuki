import { Forbidden, type Account, type StorePort } from '@tasuki/core'
import { describe, expect, it } from 'vite-plus/test'
import { createLiveInstance, parseInstance } from './instance'

const actor = (access: Account['access']): Account => ({
  userId: 'u1',
  username: 'eli',
  displayName: 'Eli',
  access,
  disabled: false,
  createdAt: '2026-11-23T00:00:00.000Z',
})

describe('parseInstance', () => {
  it('fills what is left out from the defaults, the poll from the tracker', () => {
    expect(parseInstance({}, { pollSeconds: 30 })).toEqual({
      pollSeconds: 30,
      limits: {
        maxConcurrentRuns: 2,
        leaseSeconds: 120,
        defaultMaxAttempts: 3,
        softGraceSeconds: 300,
        hardGraceSeconds: 10,
      },
    })
    expect(
      parseInstance(
        { poll: { intervalSeconds: 2 }, limits: { maxConcurrentRuns: 4 } },
        { pollSeconds: 5 },
      ),
    ).toMatchObject({ pollSeconds: 2, limits: { maxConcurrentRuns: 4, leaseSeconds: 120 } })
  })

  it('refuses a field or a limit it does not hold, and a number that is not a whole one of at least 1', () => {
    const ctx = { pollSeconds: 5 }
    expect(() => parseInstance({ agents: {} }, ctx)).toThrow('agents: not an instance setting')
    expect(() => parseInstance({ limits: { leases: 1 } }, ctx)).toThrow(
      'limits.leases: not a limit',
    )
    for (const bad of [0, 1.5, '5', -1])
      expect(() => parseInstance({ poll: { intervalSeconds: bad } }, ctx)).toThrow(
        'poll.intervalSeconds must be a whole number of at least 1',
      )
  })
})

describe('createLiveInstance', () => {
  it('only an admin saves, and a maintainer is refused before what is wrong with it', async () => {
    const live = createLiveInstance({ pollSeconds: 5 })
    // Refused before the store is reached.
    const store = {} as StorePort
    await expect(
      live.save(store, actor('maintainer'), undefined, 'nonsense'),
    ).rejects.toBeInstanceOf(Forbidden)
    expect(live.current().pollSeconds).toBe(5)
  })
})
