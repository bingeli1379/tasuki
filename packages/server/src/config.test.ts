import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { loadConfig } from './config'

const write = (config: string, env?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'tasuki-config-'))
  writeFileSync(join(dir, 'tasuki.config.jsonc'), config)
  if (env !== undefined) writeFileSync(join(dir, '.env'), env)
  return join(dir, 'tasuki.config.jsonc')
}

describe('loadConfig', () => {
  it('defaults to the sqlite tracker and resolves dataDir against the config folder', () => {
    const path = write('{ "version": 1, }')
    const config = loadConfig(path)
    expect(config.tracker).toEqual({ plugin: '@tasuki/sqlite', options: {} })
    expect(config.dataDir).toBe(join(config.configDir, 'data'))
    expect(config.statuses.item?.['refining']).toBe('Refining')
    expect(config.statuses.task?.['to-do']).toBe('To Do')
  })

  it('leaves splitting off the default mapping unless a rule claims it', () => {
    expect(loadConfig(write('{}')).statuses.item?.['splitting']).toBeUndefined()
    const claiming = write(
      JSON.stringify({
        agents: { fake: { plugin: '@tasuki/fake-runner' } },
        rules: [
          {
            id: 'split',
            watch: 'ready-to-split',
            claim: 'splitting',
            agent: 'fake',
            mode: 'split',
            on: { succeeded: 'split-review', needs_input: 'needs-answers' },
          },
        ],
      }),
    )
    expect(loadConfig(claiming).statuses.item?.['splitting']).toBe('Splitting')
  })

  it('expands ${VAR} from a .env next to the config', () => {
    const path = write(
      '{ "tracker": { "plugin": "x", "options": { "token": "${TASUKI_TEST_TOKEN}" } } }',
      'TASUKI_TEST_TOKEN=from-env-file\n',
    )
    expect(loadConfig(path).tracker.options).toEqual({ token: 'from-env-file' })
  })

  it('names the variable and where it is used when it is missing', () => {
    const path = write(
      '{ "tracker": { "plugin": "x", "options": { "token": "${TASUKI_TEST_MISSING}" } } }',
    )
    expect(() => loadConfig(path)).toThrow(
      'config tracker.options.token: environment variable TASUKI_TEST_MISSING is not set',
    )
  })

  it('refuses a mapping without refining, or with a status that does not exist', () => {
    expect(() => loadConfig(write('{ "statuses": { "item": { "done": "Done" } } }'))).toThrow(
      'must map refining',
    )
    expect(() =>
      loadConfig(write('{ "statuses": { "item": { "refining": "R", "doing": "D" } } }')),
    ).toThrow('unknown status doing')
  })

  const withRules = (rules: unknown[]): string =>
    write(
      JSON.stringify({
        agents: { fake: { plugin: '@tasuki/fake-runner', options: { seconds: 1 } } },
        rules,
      }),
    )
  const split = {
    id: 'split',
    watch: 'ready-to-split',
    claim: 'splitting',
    agent: 'fake',
    mode: 'split',
    on: { succeeded: 'split-review', needs_input: 'needs-answers' },
  }

  it('reads agents and rules, filling maxAttempts and the limits from the defaults', () => {
    const config = loadConfig(withRules([split]))
    expect(config.agents).toEqual({
      fake: { plugin: '@tasuki/fake-runner', options: { seconds: 1 } },
    })
    expect(config.rules).toEqual([{ ...split, maxAttempts: 3 }])
    expect(config.limits).toEqual({
      maxConcurrentRuns: 2,
      leaseSeconds: 120,
      defaultMaxAttempts: 3,
      softGraceSeconds: 300,
      hardGraceSeconds: 10,
    })
    expect(config.holdLabel).toBe('hold')
    expect(config.pollSeconds).toBe(5)
  })

  it('takes the hold label from labels.hold, as one word Jira can store', () => {
    expect(loadConfig(write('{ "labels": { "hold": "tasuki-hold" } }')).holdLabel).toBe(
      'tasuki-hold',
    )
    expect(() => loadConfig(write('{ "labels": { "hold": "on hold" } }'))).toThrow(
      'config labels.hold must be one word with no spaces',
    )
  })

  it('has no rules when it lists none, so the engine leaves every item alone', () => {
    expect(loadConfig(write('{}')).rules).toEqual([])
  })

  it.each([
    [
      { ...split, watch: 'ready' },
      'rules[0] (split).watch: status "ready" is not in statuses.item',
    ],
    [{ ...split, claim: 'ready-to-split' }, 'rules[0] (split).claim must differ from watch'],
    [{ ...split, agent: 'claude' }, 'rules[0] (split).agent: no agent "claude" in agents'],
    [{ ...split, mode: 'review' }, 'rules[0] (split).mode must be one of split, execute, rework'],
    [
      { ...split, on: { succeeded: 'split-review' } },
      'rules[0] (split).on.needs_input is required',
    ],
    [
      { ...split, on: { ...split.on, cancelled: 'done' } },
      'rules[0] (split).on.cancelled: not an outcome',
    ],
    [
      { ...split, maxAttempts: 0 },
      'rules[0] (split).maxAttempts must be a whole number of at least 1',
    ],
  ])('refuses a rule that cannot work: %j', (rule, message) => {
    expect(() => loadConfig(withRules([rule]))).toThrow(message)
  })

  it('refuses a rework rule the same way: it makes tasks too', () => {
    const path = write(
      JSON.stringify({
        statuses: {
          item: Object.fromEntries(
            ['refining', 'ready-to-rework', 'splitting', 'split-review', 'blocked'].map((s) => [
              s,
              s,
            ]),
          ),
          task: { 'to-do': 'T' },
        },
        agents: { fake: { plugin: 'x' } },
        rules: [
          {
            ...split,
            id: 'rework',
            watch: 'ready-to-rework',
            mode: 'rework',
            on: { succeeded: 'split-review', needs_input: 'blocked' },
          },
        ],
      }),
    )
    expect(() => loadConfig(path)).toThrow(
      'config statuses.task must map manual: rule rework makes tasks',
    )
  })

  it('refuses a split rule when the task statuses its tasks start in are not mapped', () => {
    const path = write(
      JSON.stringify({
        statuses: {
          item: Object.fromEntries(
            [
              'refining',
              'ready-to-split',
              'splitting',
              'split-review',
              'needs-answers',
              'blocked',
            ].map((s) => [s, s]),
          ),
          task: { 'to-do': 'T' },
        },
        agents: { fake: { plugin: 'x' } },
        rules: [split],
      }),
    )
    expect(() => loadConfig(path)).toThrow(
      'config statuses.task must map manual: rule split makes tasks',
    )
  })

  it('refuses an execute rule unless every task status is mapped', () => {
    const path = write(
      JSON.stringify({
        statuses: {
          item: Object.fromEntries(
            ['refining', 'in-progress', 'in-review', 'blocked'].map((s) => [s, s]),
          ),
          task: { 'to-do': 'T', manual: 'M', done: 'D' },
        },
        agents: { fake: { plugin: 'x' } },
        rules: [
          {
            id: 'execute',
            watch: 'in-progress',
            agent: 'fake',
            mode: 'execute',
            on: { succeeded: 'in-review', needs_input: 'blocked', blocked_manual: 'blocked' },
          },
        ],
      }),
    )
    expect(() => loadConfig(path)).toThrow(
      'config statuses.task must map in-progress, in-review: rule execute runs tasks',
    )
  })

  it('refuses an unknown task status', () => {
    expect(() =>
      loadConfig(
        write('{ "statuses": { "item": { "refining": "R" }, "task": { "doing": "D" } } }'),
      ),
    ).toThrow('config statuses.task: unknown status doing')
  })

  it('refuses two rules watching the same status', () => {
    expect(() => loadConfig(withRules([split, { ...split, id: 'again' }]))).toThrow(
      'config rules: split and again both watch ready-to-split',
    )
  })

  it('refuses a rule whose default failed exit, blocked, is not on the board', () => {
    const path = write(
      JSON.stringify({
        statuses: {
          item: {
            refining: 'R',
            'ready-to-split': 'S',
            splitting: 'P',
            'split-review': 'V',
            'needs-answers': 'N',
          },
        },
        agents: { fake: { plugin: 'x' } },
        rules: [split],
      }),
    )
    expect(() => loadConfig(path)).toThrow(
      'on.failed (default): status "blocked" is not in statuses.item',
    )
  })
})
