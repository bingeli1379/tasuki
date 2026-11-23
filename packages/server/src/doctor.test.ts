import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { runDoctor } from './doctor'
import { DEFAULT_FLOW } from './flow'

const clock = { now: () => new Date('2026-11-22T10:01:00Z') }

// A config folder with fake plugin packages, each a default export source, and the config.
function configWith(plugins: Record<string, string>, config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'tasuki-doctor-'))
  writeFileSync(join(dir, 'package.json'), '{}')
  for (const [name, source] of Object.entries(plugins)) {
    const pkg = join(dir, 'node_modules', name)
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, main: 'index.mjs' }))
    writeFileSync(join(pkg, 'index.mjs'), `export default ${source}`)
  }
  writeFileSync(join(dir, 'tasuki.config.jsonc'), JSON.stringify(config))
  return join(dir, 'tasuki.config.jsonc')
}

// Runs on the tracker plugin below and polls every 30 seconds, so another engine counts as
// running for 90; two agents on the runner plugin below, each picked by a rule (D105, D107:
// all of it settings kept in the store).
const RULES = [
  {
    id: 'split',
    watch: 'ready-to-split',
    agent: 'main',
    mode: 'split',
    outcomes: { succeeded: 'split-review' },
  },
  {
    id: 'review',
    watch: 'in-progress',
    agent: 'broken',
    mode: 'review',
    outcomes: { approve: 'in-review' },
  },
]
const STORE = `{ name: 'store', apiVersion: 1, store: () => ({
  latestSettings: async (doc) =>
    ({
      instance: { version: 1, value: { poll: { intervalSeconds: 30 } } },
      tracker: { version: 1, value: { plugin: 'tracker', options: {} } },
      agents: {
        version: 1,
        value: {
          main: { plugin: 'runner', options: {} },
          broken: { plugin: 'runner', options: { broken: true } },
          unused: { plugin: 'runner', options: {} },
        },
      },
      flow: { version: 1, value: ${JSON.stringify({ ...DEFAULT_FLOW, rules: RULES })} },
    })[doc],
}) }`
const tracker = (heartbeat: string) => `{
  name: 'tracker',
  apiVersion: 1,
  tracker: () => ({
    doctor: async () => [{ level: 'error', message: 'no transition from 1 to 2' }],
    readHeartbeat: async () => (${heartbeat}),
  }),
}`
const RUNNER = `{
  name: 'runner',
  apiVersion: 1,
  runner: (ctx, options) => {
    if (options.broken) throw new Error('options.model must be a model name')
    return { start() {}, doctor: async () => [{ level: 'warning', message: 'allowedTools is empty' }] }
  },
}`

function printed(): string[] {
  return vi.mocked(console.log).mock.calls.map((c) => String(c[0]))
}

describe('doctor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists every finding of every plugin instead of stopping at the first, and exits 1', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const path = configWith(
      {
        store: STORE,
        tracker: tracker(`{ engineId: 'other:/data', lastSeen: '2026-11-22T10:00:30.000Z' }`),
        runner: RUNNER,
      },
      { store: { plugin: 'store' } },
    )
    expect(await runDoctor(path, clock)).toBe(1)
    expect(printed()).toEqual([
      'error: engine: another engine runs the rules on this project: other:/data, seen 30s ago. Stop it first; one project takes one engine (D66)',
      'error: tracker tracker: no transition from 1 to 2',
      'error: agent broken: plugin "runner": create runner: options.model must be a model name',
      'warning: agent main: allowedTools is empty',
      'doctor: 3 errors, 1 warnings',
    ])
  })

  it('an engine seen three poll rounds ago, or this one after a crash, is not in the way', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const stale = configWith(
      {
        store: STORE,
        tracker: tracker(`{ engineId: 'other:/data', lastSeen: '2026-11-22T09:59:30.000Z' }`),
      },
      { store: { plugin: 'store' } },
    )
    await runDoctor(stale, clock)
    expect(printed().some((l) => l.startsWith('error: engine'))).toBe(false)

    vi.mocked(console.log).mockClear()
    const dir = mkdtempSync(join(tmpdir(), 'tasuki-doctor-own-'))
    const own = configWith(
      {
        store: STORE,
        tracker: tracker(
          `{ engineId: ${JSON.stringify(`${hostname()}:${join(dir, 'data')}`)}, lastSeen: '2026-11-22T10:00:59.000Z' }`,
        ),
      },
      {
        dataDir: join(dir, 'data'),
        store: { plugin: 'store' },
      },
    )
    await runDoctor(own, clock)
    expect(printed().some((l) => l.startsWith('error: engine'))).toBe(false)
  })

  it('a config that does not load is the one error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const path = configWith({}, { rules: [] })
    expect(await runDoctor(path, clock)).toBe(1)
    expect(printed()).toEqual([
      expect.stringMatching(/^error: config: config rules: not a field of the config file/),
      'doctor: 1 errors, 0 warnings',
    ])
  })
})
