import { createStatusMap, ITEM_STATUS_DISPLAY } from '@tasuki/core'
import { describeStorageContract } from '@tasuki/testkit'
import { openDatabase } from './database'
import { migrate } from './migrate'
import { createSqliteTracker } from './tracker'
import { TRACKER_MIGRATIONS } from './tracker-migrations'

describeStorageContract('sqlite', () => {
  const db = openDatabase(':memory:')
  migrate(db, TRACKER_MIGRATIONS)
  const ctx = {
    clock: { now: () => new Date('2026-11-16T12:00:00Z') },
    dataDir: ':memory:',
    statuses: createStatusMap({ item: ITEM_STATUS_DISPLAY }),
  }
  return Promise.resolve({ storage: createSqliteTracker(ctx, db) })
})
