import { Forbidden, InvalidInput, type Account } from '@tasuki/core'
import { createSqliteStore, migrate, openDatabase, STORE_MIGRATIONS } from '@tasuki/sqlite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { loadFlow } from './flow'
import { createLiveInstance, pollDefaultFor } from './instance'
import { loadSecrets } from './secrets'
import { createLiveTracker, DEFAULT_TRACKER, readTrackerSettings } from './tracker-settings'

const actor = (access: Account['access']): Account => ({
  userId: 'u1',
  username: 'eli',
  displayName: 'Eli',
  access,
  disabled: false,
  createdAt: '2026-11-23T00:00:00.000Z',
})
const admin = actor('admin')

// A tracker plugin with a secret, resolved from the config folder like any other; it keeps
// the options it was built with where the test can see them.
const SECRET_TRACKER = `export default {
  name: 'secret-tracker',
  apiVersion: 1,
  tracker: (ctx, options) => {
    globalThis.builtWith = options
    return { list: async () => globalThis.onTracker ?? [] }
  },
  forms: {
    tracker: {
      fields: [
        { key: 'site', label: 'Site', type: 'text', required: true },
        { key: 'auth.token', label: 'Token', type: 'secret', required: true },
      ],
    },
  },
}
`
const builtWith = () => (globalThis as { builtWith?: unknown }).builtWith

const setup = async (blocked?: string) => {
  let other = blocked
  const dir = mkdtempSync(join(tmpdir(), 'tasuki-tracker-'))
  writeFileSync(join(dir, 'secret-tracker.mjs'), SECRET_TRACKER)
  const db = openDatabase(':memory:')
  migrate(db, STORE_MIGRATIONS)
  const clock = { now: () => new Date() }
  const store = createSqliteStore(db, clock)
  const flow = await loadFlow(store, { agents: [], defaultMaxAttempts: 3 })
  const instance = createLiveInstance(pollDefaultFor(DEFAULT_TRACKER.plugin))
  const secrets = loadSecrets(dir)
  const live = await createLiveTracker(
    {
      store,
      flow,
      instance,
      secrets,
      ctx: { clock, configDir: dir, dataDir: dir },
      engineId: 'here',
      otherEngine: async () => other,
    },
    { settings: DEFAULT_TRACKER },
  )
  // From here on, another engine is seen on whatever tracker is checked.
  const block = (message: string) => {
    other = message
  }
  return { dir, store, instance, live, block }
}

describe('the tracker settings (D105, D106)', () => {
  afterEach(() => {
    delete process.env['TASUKI_SECRET_KEY']
  })

  it('starts on sqlite, never saved, with its form', async () => {
    const { live } = await setup()
    expect(await live.view()).toMatchObject({
      plugin: '@tasuki/sqlite',
      options: {},
      secretsSet: [],
      fields: [{ key: 'refPrefix', type: 'text' }],
      lookup: false,
    })
    expect((await live.view()).version).toBeUndefined()
  })

  it('a save swaps the tracker in use at once, while nothing is on the board', async () => {
    const { live } = await setup()
    expect(await live.save(admin, undefined, '@tasuki/sqlite', { refPrefix: 'LAB' })).toBe(1)
    const item = await live.port.createItem({ title: 'first', body: '', status: 'refining' })
    expect(item.ref).toBe('LAB-1')
    await expect(live.save(admin, 1, '@tasuki/sqlite', { refPrefix: 'NEW' })).rejects.toThrow(
      'move these off the tracker in use before changing it: LAB-1',
    )
    expect(live.current().options).toEqual({ refPrefix: 'LAB' })
  })

  it('the same options in another key order are the same tracker, items and all', async () => {
    const { live } = await setup()
    await live.save(admin, undefined, './secret-tracker.mjs', {
      site: 'a',
      auth: { token: 't1' },
      x: 1,
    })
    ;(globalThis as { onTracker?: unknown }).onTracker = [{ ref: 'S-1', status: 'refining' }]
    try {
      await expect(
        live.save(admin, 1, './secret-tracker.mjs', { x: 1, auth: { token: '' }, site: 'a' }),
      ).resolves.toBe(2)
      await expect(
        live.save(admin, 2, './secret-tracker.mjs', { site: 'b', auth: { token: '' } }),
      ).rejects.toThrow('move these off the tracker in use before changing it: S-1')
    } finally {
      delete (globalThis as { onTracker?: unknown }).onTracker
    }
  })

  it('keeps a secret sealed in the store and never shows it; left blank, the one in use stays', async () => {
    const { dir, store, live } = await setup()
    await live.save(admin, undefined, './secret-tracker.mjs', { site: 'a', auth: { token: 't1' } })
    const stored = JSON.stringify((await store.latestSettings('tracker'))?.value)
    expect(stored).not.toContain('t1')
    expect(stored).toContain('enc:v1:')
    expect(await live.view()).toMatchObject({
      options: { site: 'a', auth: {} },
      secretsSet: ['auth.token'],
    })
    expect(JSON.stringify(await live.view())).not.toContain('t1')

    await live.save(admin, 1, './secret-tracker.mjs', { site: 'a', auth: { token: '' } })
    expect(builtWith()).toEqual({ site: 'a', auth: { token: 't1' } })
    expect((await readTrackerSettings(store, loadSecrets(dir), dir)).settings.options).toEqual({
      site: 'a',
      auth: { token: 't1' },
    })
    process.env['TASUKI_SECRET_KEY'] = 'another key'
    await expect(readTrackerSettings(store, loadSecrets(dir), dir)).rejects.toThrow(
      'a saved secret cannot be opened',
    )
  })

  it('a new token alone is the same tracker: no other engine to ask about, nothing to move', async () => {
    const { live, block } = await setup()
    await live.save(admin, undefined, './secret-tracker.mjs', { site: 'a', auth: { token: 't1' } })
    block('another engine runs the rules on this project')
    await expect(
      live.save(admin, 1, './secret-tracker.mjs', { site: 'a', auth: { token: 't2' } }),
    ).resolves.toBe(2)
    expect(builtWith()).toEqual({ site: 'a', auth: { token: 't2' } })
    await expect(
      live.save(admin, 2, './secret-tracker.mjs', { site: 'b', auth: { token: '' } }),
    ).rejects.toThrow('another engine runs the rules on this project')
  })

  it('refuses what it cannot run on, saying why, and keeps the tracker in use', async () => {
    const { live } = await setup('another engine runs the rules on this project')
    await expect(
      live.save(admin, undefined, './secret-tracker.mjs', { site: 'a' }),
    ).rejects.toThrow('Token is required')
    await expect(
      live.save(admin, undefined, '@tasuki/sqlite', { refPrefix: 'lower' }),
    ).rejects.toBeInstanceOf(InvalidInput)
    await expect(live.save(admin, undefined, '@tasuki/nothing-here', {})).rejects.toBeInstanceOf(
      InvalidInput,
    )
    await expect(
      live.save(admin, undefined, './secret-tracker.mjs', { site: 'a', auth: { token: 't1' } }),
    ).rejects.toThrow('another engine runs the rules on this project')
    expect(live.current()).toEqual(DEFAULT_TRACKER)
  })

  it('only an admin changes it', async () => {
    const { live } = await setup()
    await expect(
      live.save(actor('maintainer'), undefined, '@tasuki/sqlite', {}),
    ).rejects.toBeInstanceOf(Forbidden)
    await expect(live.choices(actor('member'), '@tasuki/sqlite', {})).rejects.toBeInstanceOf(
      Forbidden,
    )
  })

  it('a new tracker brings its own poll default unless one was saved', async () => {
    const { instance, live } = await setup()
    expect(instance.current().pollSeconds).toBe(5)
    instance.rebase(pollDefaultFor('@tasuki/jira-cloud'))
    expect(instance.current().pollSeconds).toBe(30)
    await live.save(admin, undefined, '@tasuki/sqlite', { refPrefix: 'LAB' })
    expect(instance.current().pollSeconds).toBe(5)
  })
})
