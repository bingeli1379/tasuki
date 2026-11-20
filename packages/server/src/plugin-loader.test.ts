import { createStatusMap, ITEM_STATUS_DISPLAY, type PluginContext } from '@tasuki/core'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { loadRunner, loadTracker } from './plugin-loader'

const ctx = (dataDir: string): PluginContext => ({
  clock: { now: () => new Date('2026-11-16T12:00:00Z') },
  dataDir,
  statuses: createStatusMap({ item: ITEM_STATUS_DISPLAY }),
})

// A config folder with one fake plugin package per entry, each a default export source.
function configDirWith(plugins: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tasuki-loader-'))
  writeFileSync(join(dir, 'package.json'), '{}')
  for (const [name, source] of Object.entries(plugins)) {
    const pkg = join(dir, 'node_modules', name)
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, main: 'index.mjs' }))
    writeFileSync(join(pkg, 'index.mjs'), `export default ${source}`)
  }
  return dir
}

describe('loadTracker', () => {
  it('loads the sqlite plugin from the config folder and creates items', async () => {
    const repoRoot = resolve(import.meta.dirname, '../../..')
    const tracker = await loadTracker(
      '@tasuki/sqlite',
      {},
      repoRoot,
      ctx(mkdtempSync(join(tmpdir(), 'tasuki-data-'))),
    )
    const item = await tracker.createItem({ title: 'a', body: '', status: 'refining' })
    expect(item.ref).toBe('TSK-1')
  })

  const dir = configDirWith({
    'not-a-plugin': '{}',
    'old-api': "{ name: 'old', apiVersion: 0, tracker: () => ({}) }",
    'no-tracker': "{ name: 'none', apiVersion: 1 }",
    'bad-options':
      "{ name: 'bad', apiVersion: 1, tracker: () => { throw new Error('options.x is required') } }",
  })

  it.each([
    ['missing', 'plugin "missing": resolve:'],
    ['not-a-plugin', 'plugin "not-a-plugin": check export: default export is not a definePlugin'],
    ['old-api', 'plugin "old-api": check export: apiVersion 0, engine expects 1'],
    ['no-tracker', 'plugin "no-tracker": check export: does not provide a tracker'],
    ['bad-options', 'plugin "bad-options": create tracker: options.x is required'],
  ])('refuses %s with the step that failed', async (name, message) => {
    await expect(loadTracker(name, {}, dir, ctx(dir))).rejects.toThrow(message)
  })
})

describe('loadRunner', () => {
  it('loads the fake runner from the config folder', async () => {
    const repoRoot = resolve(import.meta.dirname, '../../..')
    const runner = await loadRunner('@tasuki/fake-runner', { seconds: 0 }, repoRoot, ctx(repoRoot))
    expect(typeof runner.start).toBe('function')
  })

  it('refuses a plugin without a runner', async () => {
    const dir = configDirWith({
      'only-tracker': "{ name: 'x', apiVersion: 1, tracker: () => ({}) }",
    })
    await expect(loadRunner('only-tracker', {}, dir, ctx(dir))).rejects.toThrow(
      'plugin "only-tracker": check export: does not provide a runner',
    )
  })
})
