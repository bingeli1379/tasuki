import { describe, expect, it } from 'vite-plus/test'
import type { Heartbeat, TrackerPort } from '../ports/tracker'
import { beat, clearHeartbeat, otherEngine } from './heartbeat'

function fakeTracker(initial?: Heartbeat): {
  tracker: TrackerPort
  stored: () => Heartbeat | undefined
} {
  let stored = initial
  const tracker = {
    readHeartbeat: async () => stored,
    writeHeartbeat: async (b: Heartbeat | undefined) => {
      stored = b
    },
  } as unknown as TrackerPort
  return { tracker, stored: () => stored }
}

const at = (iso: string) => ({ now: () => new Date(iso) })

describe('heartbeat (D66)', () => {
  it('another engine seen within the window stops the start', async () => {
    const { tracker } = fakeTracker({ engineId: 'b', lastSeen: '2026-11-22T10:00:00.000Z' })
    expect(await otherEngine(tracker, at('2026-11-22T10:01:29Z'), 'a', 90)).toEqual({
      engineId: 'b',
      lastSeen: '2026-11-22T10:00:00.000Z',
    })
    expect(await otherEngine(tracker, at('2026-11-22T10:01:30Z'), 'a', 90)).toBeUndefined()
  })

  it('its own heartbeat, left by a crash, does not, nor a tracker that keeps none', async () => {
    const { tracker } = fakeTracker({ engineId: 'a', lastSeen: '2026-11-22T10:00:00.000Z' })
    expect(await otherEngine(tracker, at('2026-11-22T10:00:01Z'), 'a', 90)).toBeUndefined()
    expect(
      await otherEngine({} as TrackerPort, at('2026-11-22T10:00:01Z'), 'a', 90),
    ).toBeUndefined()
  })

  it('beats with the clock, and a shutdown clears only its own', async () => {
    const mine = fakeTracker()
    await beat(mine.tracker, at('2026-11-22T10:00:00Z'), 'a')
    expect(mine.stored()).toEqual({ engineId: 'a', lastSeen: '2026-11-22T10:00:00.000Z' })
    await clearHeartbeat(mine.tracker, 'a')
    expect(mine.stored()).toBeUndefined()

    const theirs = fakeTracker({ engineId: 'b', lastSeen: '2026-11-22T10:00:00.000Z' })
    await clearHeartbeat(theirs.tracker, 'a')
    expect(theirs.stored()?.engineId).toBe('b')
  })
})
