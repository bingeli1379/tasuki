import { createStatusMap } from '@tasuki/core'
import { describeStoreContract } from '@tasuki/testkit'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { openDatabase } from './database'
import plugin from './index'
import { migrate } from './migrate'
import { createSqliteStore } from './store'
import { STORE_MIGRATIONS } from './store-migrations'

describeStoreContract('sqlite', async (clock) => {
  const db = openDatabase(':memory:')
  migrate(db, STORE_MIGRATIONS)
  return { store: createSqliteStore(db, clock) }
})

describe('sqlite store plugin', () => {
  it('keeps its own file under dataDir, apart from the tracker', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tasuki-store-'))
    const ctx = {
      clock: { now: () => new Date() },
      configDir: '',
      dataDir,
      statuses: createStatusMap({}),
    }
    const store = await plugin.store?.(ctx, {})
    await store?.setPaused(true)
    expect(existsSync(join(dataDir, 'store.db'))).toBe(true)
    expect(existsSync(join(dataDir, 'tracker.db'))).toBe(false)
    expect(await (await plugin.store?.(ctx, {}))?.isPaused()).toBe(true)
  })
})
