import { Forbidden, InvalidInput, type Account } from '@tasuki/core'
import { createSqliteStore, migrate, openDatabase, STORE_MIGRATIONS } from '@tasuki/sqlite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { createLiveAgents, DEFAULT_AGENTS, readAgentSettings } from './agent-settings'
import { createLiveFlow, DEFAULT_FLOW, parseFlow } from './flow'
import { loadSecrets } from './secrets'

const actor = (access: Account['access']): Account => ({
  userId: 'u1',
  username: 'eli',
  displayName: 'Eli',
  access,
  disabled: false,
  createdAt: '2026-11-23T00:00:00.000Z',
})
const admin = actor('admin')

// A runner plugin with a secret, resolved from the config folder like any other; each runner
// it builds says which options it was built with.
const KEYED_RUNNER = `export default {
  name: 'keyed-runner',
  apiVersion: 1,
  runner: (ctx, options) => {
    if (options.fail) throw new Error('options.fail: cannot run')
    return {
      start: () => ({ exit: Promise.resolve({ code: 0, signal: null }), terminate() {} }),
      doctor: async () => [{ level: 'warning', message: 'built with ' + JSON.stringify(options) }],
    }
  },
  forms: {
    runner: {
      fields: [
        { key: 'model', label: 'Model', type: 'text', required: true },
        { key: 'env.KEY', label: 'Key', type: 'secret' },
        { key: 'tools', label: 'Tools', type: 'list' },
      ],
      allow: ({ tool }) => ({ key: 'tools', entry: tool }),
    },
  },
}
`
const RUNNER = './keyed-runner.mjs'

const RULES = [
  {
    id: 'split',
    watch: 'ready-to-split',
    agent: 'main',
    mode: 'split',
    outcomes: { succeeded: 'split-review' },
  },
]

const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasuki-agents-'))
  writeFileSync(join(dir, 'keyed-runner.mjs'), KEYED_RUNNER)
  const db = openDatabase(':memory:')
  migrate(db, STORE_MIGRATIONS)
  const clock = { now: () => new Date() }
  const store = createSqliteStore(db, clock)
  const raw = { ...DEFAULT_FLOW, rules: RULES }
  const ctx = { agents: ['main'], defaultMaxAttempts: 3 }
  const flow = createLiveFlow(ctx, { flow: parseFlow(raw, ctx), raw })
  const secrets = loadSecrets(dir)
  const live = await createLiveAgents(
    {
      store,
      flow,
      secrets,
      ctx: { clock, configDir: dir, dataDir: dir, statuses: flow.statuses },
    },
    { settings: { main: { plugin: RUNNER, options: { model: 'm1' } } } },
  )
  return { dir, store, flow, secrets, live }
}

// What each agent's runner was built with, by asking it.
const builtWith = async (live: Awaited<ReturnType<typeof setup>>['live']) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(live.runners()).map(async ([name, r]) => [
        name,
        JSON.parse(((await r.doctor?.()) ?? [])[0]?.message.replace('built with ', '') ?? '{}'),
      ]),
    ),
  )

describe('the agents settings (D107, D110)', () => {
  it('starts on claude and codex, never saved', async () => {
    const { dir, store, secrets } = await setup()
    expect(await readAgentSettings(store, secrets, dir)).toEqual({ settings: DEFAULT_AGENTS })
    expect(Object.keys(DEFAULT_AGENTS)).toEqual(['claude', 'codex'])
  })

  it('a save adds an agent, runs the next Run on the new options, and lets rules pick it', async () => {
    const { flow, live } = await setup()
    const version = await live.save(admin, undefined, {
      main: { plugin: RUNNER, options: { model: 'm2' } },
      review: { plugin: RUNNER, options: { model: 'r1' } },
    })
    expect(version).toBe(1)
    expect(await builtWith(live)).toEqual({ main: { model: 'm2' }, review: { model: 'r1' } })
    expect(flow.context.agents).toEqual(['main', 'review'])
    expect((await live.view()).agents.map((a) => a.name)).toEqual(['main', 'review'])
  })

  it('keeps a secret sealed in the store and never shows it; left blank, the saved one stays', async () => {
    const { dir, store, secrets, live } = await setup()
    await live.save(admin, undefined, {
      main: { plugin: RUNNER, options: { model: 'm1', env: { KEY: 'k1' } } },
    })
    const stored = JSON.stringify((await store.latestSettings('agents'))?.value)
    expect(stored).not.toContain('k1')
    expect(stored).toContain('enc:v1:')
    const view = await live.view()
    expect(view.agents[0]).toMatchObject({
      options: { model: 'm1', env: {} },
      secretsSet: ['env.KEY'],
    })
    expect(JSON.stringify(view)).not.toContain('k1')

    await live.save(admin, 1, {
      main: { plugin: RUNNER, options: { model: 'm2', env: { KEY: '' } } },
    })
    expect(await builtWith(live)).toEqual({ main: { model: 'm2', env: { KEY: 'k1' } } })
    expect((await readAgentSettings(store, secrets, dir)).settings).toEqual({
      main: { plugin: RUNNER, options: { model: 'm2', env: { KEY: 'k1' } } },
    })
  })

  it('refuses to drop an agent a rule picks, and keeps the agents in use', async () => {
    const { live } = await setup()
    await expect(
      live.save(admin, undefined, { other: { plugin: RUNNER, options: { model: 'o' } } }),
    ).rejects.toThrow(
      'rules still use these agents; point them elsewhere on the Workflow page first: split (main)',
    )
    expect(Object.keys(live.runners())).toEqual(['main'])
  })

  it('refuses what it cannot run, saying why, and keeps the agents in use', async () => {
    const { live } = await setup()
    await expect(
      live.save(admin, undefined, { main: { plugin: RUNNER, options: {} } }),
    ).rejects.toThrow('agent main: Model is required')
    await expect(
      live.save(admin, undefined, {
        main: { plugin: RUNNER, options: { model: 'm', fail: true } },
      }),
    ).rejects.toThrow(
      'agent main: plugin "./keyed-runner.mjs": create runner: options.fail: cannot run',
    )
    await expect(
      live.save(admin, undefined, { main: { plugin: '@tasuki/nothing-here', options: {} } }),
    ).rejects.toBeInstanceOf(InvalidInput)
    await expect(
      live.save(admin, undefined, { Main: { plugin: RUNNER, options: { model: 'm' } } }),
    ).rejects.toThrow('agent name Main')
    expect(await builtWith(live)).toEqual({ main: { model: 'm1' } })
  })

  it("a call allowed for good joins the agent's list once, and the next Run has it (D107)", async () => {
    const { store, live } = await setup()
    await live.allow(admin, 'main', { tool: 'Bash', input: { command: 'git push' } })
    await live.allow(admin, 'main', { tool: 'Bash', input: { command: 'git push' } })
    expect(await builtWith(live)).toEqual({ main: { model: 'm1', tools: ['Bash'] } })
    expect((await store.latestSettings('agents'))?.version).toBe(1)
    await expect(
      live.allow(actor('member'), 'main', { tool: 'Read', input: {} }),
    ).rejects.toBeInstanceOf(Forbidden)
  })

  it('only an admin changes it', async () => {
    const { live } = await setup()
    await expect(
      live.save(actor('maintainer'), undefined, {
        main: { plugin: RUNNER, options: { model: 'm' } },
      }),
    ).rejects.toBeInstanceOf(Forbidden)
  })
})
