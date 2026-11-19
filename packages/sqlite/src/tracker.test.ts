import { createStatusMap, ITEM_STATUS_DISPLAY, type PluginContext } from '@tasuki/core'
import { describeStorageContract } from '@tasuki/testkit'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { openDatabase } from './database'
import plugin from './index'
import { migrate } from './migrate'
import { createSqliteTracker } from './tracker'
import { TRACKER_MIGRATIONS } from './tracker-migrations'

const ctx = (dataDir = ':memory:'): PluginContext => ({
  clock: { now: () => new Date('2026-11-16T12:00:00Z') },
  dataDir,
  statuses: createStatusMap({ item: ITEM_STATUS_DISPLAY }),
})

const memoryTracker = (refPrefix: string): ReturnType<typeof createSqliteTracker> => {
  const db = openDatabase(':memory:')
  migrate(db, TRACKER_MIGRATIONS)
  return createSqliteTracker(ctx(), db, refPrefix)
}

describeStorageContract('sqlite', () => Promise.resolve({ storage: memoryTracker('TSK') }))

describe('sqlite refs', () => {
  it('numbers refs in order under the configured prefix', async () => {
    const tracker = memoryTracker('APP')
    const a = await tracker.createItem({ title: 'a', body: '', status: 'refining' })
    const b = await tracker.createItem({ title: 'b', body: '', status: 'refining' })
    expect([a.ref, b.ref]).toEqual(['APP-1', 'APP-2'])
  })

  it('defaults the prefix to TSK and rejects one that is not a key', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tasuki-sqlite-'))
    const tracker = await plugin.tracker?.(ctx(dataDir), {})
    expect((await tracker?.createItem({ title: 'a', body: '', status: 'refining' }))?.ref).toBe(
      'TSK-1',
    )
    expect(() => plugin.tracker?.(ctx(dataDir), { refPrefix: 'my app' })).toThrow(
      'options.refPrefix',
    )
  })
})
