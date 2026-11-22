import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { loadConfig } from './config'
import { defaultPrompt } from './prompts'

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
            outcomes: { succeeded: 'split-review', needs_input: 'needs-answers' },
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

  it('defaults to the ten stations and their roles, keyed by display name', () => {
    const { workflow } = loadConfig(write('{}'))
    expect(workflow.roles).toEqual({ entry: 'refining', failure: 'blocked' })
    expect(workflow.statuses.find((s) => s.id === 'in-review')).toEqual({
      id: 'in-review',
      name: 'In Review',
      handledBy: 'person',
      outcomes: ['ready-to-rework', 'done'],
    })
  })

  // A workflow whose first station is the entry and last the failure one.
  const flow = (ids: string[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
    statuses: ids.map((id) => ({ id })),
    roles: { entry: ids[0], failure: ids.at(-1) },
    ...over,
  })

  it('reads the stations in the order listed, with names, keys and outcomes', () => {
    const config = loadConfig(
      write(
        JSON.stringify({
          workflow: {
            statuses: [
              { id: 'triage', key: '10001' },
              {
                id: 'ai-review',
                name: 'AI Review',
                handledBy: 'person',
                outcomes: ['shipped'],
              },
              { id: 'shipped' },
            ],
            roles: { entry: 'triage', failure: 'triage' },
            taskStatuses: { 'to-do': '10002' },
          },
        }),
      ),
    )
    expect(config.workflow).toEqual({
      statuses: [
        { id: 'triage', name: 'Triage', outcomes: [] },
        { id: 'ai-review', name: 'AI Review', handledBy: 'person', outcomes: ['shipped'] },
        { id: 'shipped', name: 'Shipped', outcomes: [] },
      ],
      roles: { entry: 'triage', failure: 'triage' },
    })
    // Without a key, the tracker stores the name, as sqlite does.
    expect(config.statuses).toEqual({
      item: { triage: '10001', 'ai-review': 'AI Review', shipped: 'Shipped' },
      task: { 'to-do': '10002' },
    })
  })

  it.each([
    [{ workflow: { statuses: [] } }, 'config workflow.statuses must list at least one status'],
    [{ workflow: flow(['Triage']) }, 'workflow.statuses[0].id must be a kebab-case name'],
    [{ workflow: flow(['a', 'a']) }, 'config workflow.statuses: a is listed twice'],
    [
      {
        workflow: {
          ...flow(['a', 'b']),
          statuses: [
            { id: 'a', key: 'K' },
            { id: 'b', key: 'K' },
          ],
        },
      },
      'config workflow.statuses: a and b share the tracker key K',
    ],
    [
      {
        workflow: {
          ...flow(['a', 'b']),
          statuses: [{ id: 'a', handledBy: 'engine' }, { id: 'b' }],
        },
      },
      'workflow.statuses[0] (a).handledBy can only be person',
    ],
    [
      {
        workflow: {
          ...flow(['a', 'b']),
          statuses: [{ id: 'a', outcomes: ['c'] }, { id: 'b' }],
        },
      },
      'workflow.statuses (a).outcomes: status "c" is not in workflow.statuses',
    ],
    [
      {
        workflow: {
          ...flow(['a', 'b']),
          statuses: [{ id: 'a', outcomes: ['a'] }, { id: 'b' }],
        },
      },
      'workflow.statuses (a).outcomes: a must be another status',
    ],
    [
      { workflow: { ...flow(['a', 'b']), statuses: [{ id: 'a', outcomes: { Go: 'b' } }] } },
      'workflow.statuses[0] (a).outcomes must list statuses',
    ],
    [
      { workflow: { ...flow(['a', 'b']), statuses: [{ id: 'a', outcomes: ['b', 'b'] }] } },
      'workflow.statuses[0] (a).outcomes lists a status twice',
    ],
    [{ workflow: { statuses: [{ id: 'a' }] } }, 'config workflow.roles is required'],
    [
      { workflow: flow(['a'], { roles: { failure: 'a' } }) },
      'config workflow.roles.entry is required',
    ],
    [
      { workflow: flow(['a'], { roles: { entry: 'a', failure: 'z' } }) },
      'config workflow.roles.failure: status "z" is not in workflow.statuses',
    ],
    [
      { workflow: flow(['a'], { roles: { entry: 'a', failure: 'a', start: 'a' } }) },
      'config workflow.roles.start: not a role',
    ],
    [
      { workflow: flow(['a'], { taskStatuses: { doing: 'D' } }) },
      'config workflow.taskStatuses: unknown status doing',
    ],
  ])('refuses a workflow that cannot work: %j', (config, message) => {
    expect(() => loadConfig(write(JSON.stringify(config)))).toThrow(message)
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
    outcomes: { succeeded: 'split-review', needs_input: 'needs-answers' },
  }

  it('reads agents and rules, filling maxAttempts and the limits from the defaults', () => {
    const config = loadConfig(withRules([split]))
    expect(config.agents).toEqual({
      fake: { plugin: '@tasuki/fake-runner', options: { seconds: 1 } },
    })
    expect(config.rules).toEqual([
      {
        ...split,
        // From the failure role.
        outcomes: { ...split.outcomes, failed: 'blocked', max_attempts: 'blocked' },
        maxAttempts: 3,
        prompt: defaultPrompt('split'),
        session: 'fresh',
      },
    ])
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

  it('takes the prompt from the rule, or from a file next to the config', () => {
    const inline = loadConfig(withRules([{ ...split, prompt: 'Split {{item.ref}}.' }]))
    expect(inline.rules[0]?.prompt).toBe('Split {{item.ref}}.')
    const path = withRules([{ ...split, promptFile: 'split.md', session: 'per-item' }])
    writeFileSync(join(path, '..', 'split.md'), 'From a file.')
    expect(loadConfig(path).rules[0]).toMatchObject({ prompt: 'From a file.', session: 'per-item' })
  })

  it('takes the hold label from labels.hold, as one word Jira can store', () => {
    expect(loadConfig(write('{ "labels": { "hold": "tasuki-hold" } }')).holdLabel).toBe(
      'tasuki-hold',
    )
    expect(() => loadConfig(write('{ "labels": { "hold": "on hold" } }'))).toThrow(
      'config labels.hold must be one word with no spaces',
    )
  })

  it('reads a review rule: its own outcomes as declared, then the ones every rule has', () => {
    const review = {
      id: 'ai-review',
      watch: 'in-review',
      agent: 'fake',
      mode: 'review',
      outcomes: { approve: 'done', changes: 'ready-to-rework' },
    }
    const [rule] = loadConfig(withRules([review])).rules
    expect(Object.entries(rule?.outcomes ?? {})).toEqual([
      ['approve', 'done'],
      ['changes', 'ready-to-rework'],
      ['needs_input', 'blocked'],
      ['failed', 'blocked'],
      ['max_attempts', 'blocked'],
    ])
    expect(rule?.prompt).toBe(defaultPrompt('review'))
  })

  it('has no rules when it lists none, so the engine leaves every item alone', () => {
    expect(loadConfig(write('{}')).rules).toEqual([])
  })

  it.each([
    [
      { ...split, watch: 'ready' },
      'rules[0] (split).watch: status "ready" is not in workflow.statuses',
    ],
    [{ ...split, claim: 'ready-to-split' }, 'rules[0] (split).claim must differ from watch'],
    [{ ...split, agent: 'claude' }, 'rules[0] (split).agent: no agent "claude" in agents'],
    [
      { ...split, mode: 'judge' },
      'rules[0] (split).mode must be one of split, execute, rework, review',
    ],
    [
      { ...split, outcomes: { needs_input: 'needs-answers' } },
      'rules[0] (split).outcomes.succeeded is required in split mode',
    ],
    [
      { ...split, mode: 'execute', outcomes: { succeeded: 'in-review' } },
      'rules[0] (split).outcomes.blocked_manual is required in execute mode',
    ],
    [
      { ...split, mode: 'review', outcomes: { needs_input: 'blocked' } },
      'rules[0] (split).outcomes must name at least one way for the agent to finish',
    ],
    [
      { ...split, outcomes: { ...split.outcomes, cancelled: 'done' } },
      'rules[0] (split).outcomes.cancelled: the item does not move on it',
    ],
    [
      { ...split, outcomes: { ...split.outcomes, 'Looks good': 'done' } },
      'rules[0] (split).outcomes.Looks good: a name such as needs_design',
    ],
    [
      { ...split, outcomes: { ...split.outcomes, approve: 'approved' } },
      'rules[0] (split).outcomes.approve: status "approved" is not in workflow.statuses',
    ],
    [
      { ...split, maxAttempts: 0 },
      'rules[0] (split).maxAttempts must be a whole number of at least 1',
    ],
    [{ ...split, session: 'always' }, 'rules[0] (split).session must be one of fresh, per-item'],
    [{ ...split, prompt: 'a', promptFile: 'b.md' }, 'rules[0] (split): set prompt or promptFile'],
    [{ ...split, promptFile: 'missing.md' }, 'missing.md does not exist'],
  ])('refuses a rule that cannot work: %j', (rule, message) => {
    expect(() => loadConfig(withRules([rule]))).toThrow(message)
  })

  it('refuses a rework rule the same way: it makes tasks too', () => {
    const path = write(
      JSON.stringify({
        workflow: flow(['refining', 'ready-to-rework', 'splitting', 'split-review', 'blocked'], {
          roles: {
            entry: 'refining',
            failure: 'blocked',
          },
          taskStatuses: { 'to-do': 'T' },
        }),
        agents: { fake: { plugin: 'x' } },
        rules: [
          {
            ...split,
            id: 'rework',
            watch: 'ready-to-rework',
            mode: 'rework',
            outcomes: { succeeded: 'split-review', needs_input: 'blocked' },
          },
        ],
      }),
    )
    expect(() => loadConfig(path)).toThrow(
      'config workflow.taskStatuses must map manual: rule rework makes tasks',
    )
  })

  it('refuses a split rule when the task statuses its tasks start in are not mapped', () => {
    const path = write(
      JSON.stringify({
        workflow: flow(
          ['refining', 'ready-to-split', 'splitting', 'split-review', 'needs-answers', 'blocked'],
          {
            roles: {
              entry: 'refining',
              failure: 'blocked',
            },
            taskStatuses: { 'to-do': 'T' },
          },
        ),
        agents: { fake: { plugin: 'x' } },
        rules: [split],
      }),
    )
    expect(() => loadConfig(path)).toThrow(
      'config workflow.taskStatuses must map manual: rule split makes tasks',
    )
  })

  it('refuses an execute rule unless every task status is mapped', () => {
    const path = write(
      JSON.stringify({
        workflow: flow(['refining', 'in-progress', 'in-review', 'blocked'], {
          taskStatuses: { 'to-do': 'T', manual: 'M', done: 'D' },
        }),
        agents: { fake: { plugin: 'x' } },
        rules: [
          {
            id: 'execute',
            watch: 'in-progress',
            agent: 'fake',
            mode: 'execute',
            outcomes: { succeeded: 'in-review', needs_input: 'blocked', blocked_manual: 'blocked' },
          },
        ],
      }),
    )
    expect(() => loadConfig(path)).toThrow(
      'config workflow.taskStatuses must map in-progress, in-review: rule execute runs tasks',
    )
  })

  it('refuses two rules watching the same status', () => {
    expect(() => loadConfig(withRules([split, { ...split, id: 'again' }]))).toThrow(
      'config rules: split and again both watch ready-to-split',
    )
  })

  const splitStations = ['refining', 'ready-to-split', 'splitting', 'split-review', 'needs-answers']

  it('sends needs_input, failed and max_attempts to the failure station unless the rule says otherwise', () => {
    const path = write(
      JSON.stringify({
        workflow: flow(splitStations, {
          roles: {
            entry: 'refining',
            failure: 'refining',
          },
        }),
        agents: { fake: { plugin: 'x' } },
        rules: [
          split,
          {
            ...split,
            id: 'own',
            watch: 'refining',
            outcomes: { ...split.outcomes, failed: 'needs-answers' },
          },
          { ...split, id: 'bare', watch: 'needs-answers', outcomes: { succeeded: 'split-review' } },
        ],
      }),
    )
    expect(
      loadConfig(path).rules.map((r) => [
        r.outcomes.needs_input,
        r.outcomes.failed,
        r.outcomes.max_attempts,
      ]),
    ).toEqual([
      ['needs-answers', 'refining', 'refining'],
      ['needs-answers', 'needs-answers', 'refining'],
      ['refining', 'refining', 'refining'],
    ])
  })

  it('sends work back to the status the rework rule watches, and only one', () => {
    const rework = { ...split, id: 'rework', watch: 'ready-to-rework', mode: 'rework' }
    const config = (rules: unknown[]) =>
      write(
        JSON.stringify({
          workflow: flow([...splitStations, 'ready-to-rework', 'redo']),
          agents: { fake: { plugin: 'x' } },
          rules,
        }),
      )
    expect(loadConfig(config([split])).workflow.roles.rework).toBeUndefined()
    expect(loadConfig(config([split, rework])).workflow.roles.rework).toBe('ready-to-rework')
    expect(() => loadConfig(config([rework, { ...rework, id: 'again', watch: 'redo' }]))).toThrow(
      'config rules: rework rules must watch one status, not ready-to-rework, redo',
    )
  })
})
