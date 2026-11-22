import { DEFAULT_WORKFLOW, InvalidInput } from '@tasuki/core'
import { describe, expect, it } from 'vite-plus/test'
import { DEFAULT_FLOW, parseFlow } from './flow'
import { defaultPrompt } from './prompts'

const ctx = { agents: ['fake'], defaultMaxAttempts: 3 }
const parse = (raw: unknown) => parseFlow(raw, ctx)

// The default stations with splitting, which split rules claim.
const workflow = { statuses: DEFAULT_WORKFLOW.statuses, roles: DEFAULT_WORKFLOW.roles }
const withRules = (rules: unknown[]) => ({ workflow, rules })

// A workflow whose first station is the entry and last the failure one.
const stations = (ids: string[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  statuses: ids.map((id) => ({ id })),
  roles: { entry: ids[0], failure: ids.at(-1) },
  ...over,
})

const split = {
  id: 'split',
  watch: 'ready-to-split',
  claim: 'splitting',
  agent: 'fake',
  mode: 'split',
  outcomes: { succeeded: 'split-review', needs_input: 'needs-answers' },
}

describe('parseFlow', () => {
  it('the default is the default stations but splitting, keyed by logical name, with no rules', () => {
    const flow = parse(DEFAULT_FLOW)
    expect(flow.workflow.roles).toEqual({ entry: 'refining', failure: 'blocked' })
    expect(flow.workflow.statuses.map((s) => s.id)).not.toContain('splitting')
    expect(flow.workflow.statuses.find((s) => s.id === 'in-review')).toEqual({
      id: 'in-review',
      name: 'In Review',
      handledBy: 'person',
      outcomes: ['ready-to-rework', 'done'],
    })
    expect(flow.statuses.item?.['in-review']).toBe('in-review')
    expect(flow.statuses.task?.['to-do']).toBe('to-do')
    expect(flow.rules).toEqual([])
    expect(flow.holdLabel).toBe('hold')
  })

  it('reads the stations in the order listed, with names, keys and outcomes', () => {
    const flow = parse({
      workflow: {
        statuses: [
          { id: 'triage', key: '10001' },
          { id: 'ai-review', name: 'AI Review', handledBy: 'person', outcomes: ['shipped'] },
          { id: 'shipped' },
        ],
        roles: { entry: 'triage', failure: 'triage' },
        taskStatuses: { 'to-do': '10002' },
      },
    })
    expect(flow.workflow).toEqual({
      statuses: [
        { id: 'triage', name: 'Triage', outcomes: [] },
        { id: 'ai-review', name: 'AI Review', handledBy: 'person', outcomes: ['shipped'] },
        { id: 'shipped', name: 'Shipped', outcomes: [] },
      ],
      roles: { entry: 'triage', failure: 'triage' },
    })
    // Without a key the tracker stores the logical name, so a new display name moves nothing.
    expect(flow.statuses).toEqual({
      item: { triage: '10001', 'ai-review': 'ai-review', shipped: 'shipped' },
      task: { 'to-do': '10002' },
    })
  })

  it.each([
    [undefined, 'the flow must be an object'],
    [{ workflow, statuses: [] }, 'statuses: not part of the flow'],
    [{}, 'workflow is required'],
    [{ workflow: { statuses: [] } }, 'workflow.statuses must list at least one status'],
    [{ workflow: stations(['Triage']) }, 'workflow.statuses[0].id must be a kebab-case name'],
    [{ workflow: stations(['a', 'a']) }, 'workflow.statuses: a is listed twice'],
    [
      {
        workflow: {
          ...stations(['a', 'b']),
          statuses: [
            { id: 'a', key: 'K' },
            { id: 'b', key: 'K' },
          ],
        },
      },
      'workflow.statuses: a and b share the tracker key K',
    ],
    [
      {
        workflow: {
          ...stations(['a', 'b']),
          statuses: [{ id: 'a', handledBy: 'engine' }, { id: 'b' }],
        },
      },
      'workflow.statuses[0] (a).handledBy can only be person',
    ],
    [
      {
        workflow: {
          ...stations(['a', 'b']),
          statuses: [{ id: 'a', outcomes: ['c'] }, { id: 'b' }],
        },
      },
      'workflow.statuses (a).outcomes: status "c" is not in workflow.statuses',
    ],
    [
      {
        workflow: {
          ...stations(['a', 'b']),
          statuses: [{ id: 'a', outcomes: ['a'] }, { id: 'b' }],
        },
      },
      'workflow.statuses (a).outcomes: a must be another status',
    ],
    [
      { workflow: { ...stations(['a', 'b']), statuses: [{ id: 'a', outcomes: { Go: 'b' } }] } },
      'workflow.statuses[0] (a).outcomes must list statuses',
    ],
    [
      { workflow: { ...stations(['a', 'b']), statuses: [{ id: 'a', outcomes: ['b', 'b'] }] } },
      'workflow.statuses[0] (a).outcomes lists a status twice',
    ],
    [{ workflow: { statuses: [{ id: 'a' }] } }, 'workflow.roles is required'],
    [
      { workflow: stations(['a'], { roles: { failure: 'a' } }) },
      'workflow.roles.entry is required',
    ],
    [
      { workflow: stations(['a'], { roles: { entry: 'a', failure: 'z' } }) },
      'workflow.roles.failure: status "z" is not in workflow.statuses',
    ],
    [
      { workflow: stations(['a'], { roles: { entry: 'a', failure: 'a', start: 'a' } }) },
      'workflow.roles.start: not a role',
    ],
    [
      { workflow: stations(['a'], { taskStatuses: { doing: 'D' } }) },
      'workflow.taskStatuses: unknown status doing',
    ],
    [
      { workflow: stations(['a'], { taskStatuses: { 'to-do': '' } }) },
      "workflow.taskStatuses.to-do must be the tracker's status",
    ],
    [{ workflow, labels: { hold: 'on hold' } }, 'labels.hold must be one word with no spaces'],
  ])('refuses a flow that cannot work: %j', (raw, message) => {
    expect(() => parse(raw)).toThrow(new InvalidInput(message).message)
    expect(() => parse(raw)).toThrow(InvalidInput)
  })

  it('reads rules, filling maxAttempts from the file and the prompt from the mode', () => {
    expect(parse(withRules([split])).rules).toEqual([
      {
        ...split,
        // From the failure role.
        outcomes: { ...split.outcomes, failed: 'blocked', max_attempts: 'blocked' },
        maxAttempts: 3,
        prompt: defaultPrompt('split'),
        session: 'fresh',
      },
    ])
    expect(
      parseFlow(withRules([split]), { ...ctx, defaultMaxAttempts: 5 }).rules[0]?.maxAttempts,
    ).toBe(5)
  })

  it('takes the prompt as written, and the hold label from labels.hold', () => {
    const flow = parse({
      ...withRules([{ ...split, prompt: 'Split {{item.ref}}.', session: 'per-item' }]),
      labels: { hold: 'tasuki-hold' },
    })
    expect(flow.rules[0]).toMatchObject({ prompt: 'Split {{item.ref}}.', session: 'per-item' })
    expect(flow.holdLabel).toBe('tasuki-hold')
  })

  it('reads a review rule: its own outcomes as declared, then the ones every rule has', () => {
    const review = {
      id: 'ai-review',
      watch: 'in-review',
      agent: 'fake',
      mode: 'review',
      outcomes: { approve: 'done', changes: 'ready-to-rework' },
    }
    const [rule] = parse(withRules([review])).rules
    expect(Object.entries(rule?.outcomes ?? {})).toEqual([
      ['approve', 'done'],
      ['changes', 'ready-to-rework'],
      ['needs_input', 'blocked'],
      ['failed', 'blocked'],
      ['max_attempts', 'blocked'],
    ])
    expect(rule?.prompt).toBe(defaultPrompt('review'))
  })

  it.each([
    [
      { ...split, watch: 'ready' },
      'rules[0] (split).watch: status "ready" is not in workflow.statuses',
    ],
    [{ ...split, claim: 'ready-to-split' }, 'rules[0] (split).claim must differ from watch'],
    [
      { ...split, agent: 'claude' },
      `rules[0] (split).agent: no agent "claude" in the config file's agents`,
    ],
    [
      { ...split, mode: 'judge' },
      'rules[0] (split).mode must be one of split, execute, rework, review, custom',
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
    [{ ...split, prompt: '' }, 'rules[0] (split).prompt is required'],
    // The default has no splitting: a rule claiming it needs a station for it.
    [split, 'rules[0] (split).claim: status "splitting" is not in workflow.statuses', DEFAULT_FLOW],
  ])('refuses a rule that cannot work: %j', (rule, message, base: object = { workflow }) => {
    expect(() => parse({ ...base, rules: [rule] })).toThrow(message)
  })

  it('refuses split and rework rules when the task statuses their tasks start in are not mapped', () => {
    const tasksAt = (ids: string[], rule: object) => ({
      workflow: stations(ids, { taskStatuses: { 'to-do': 'T' } }),
      rules: [rule],
    })
    expect(() =>
      parse(
        tasksAt(
          ['refining', 'ready-to-split', 'splitting', 'split-review', 'needs-answers', 'blocked'],
          split,
        ),
      ),
    ).toThrow('workflow.taskStatuses must map manual: rule split makes tasks')
    const rework = {
      ...split,
      id: 'rework',
      watch: 'ready-to-rework',
      mode: 'rework',
      outcomes: { succeeded: 'split-review', needs_input: 'blocked' },
    }
    expect(() =>
      parse(
        tasksAt(['refining', 'ready-to-rework', 'splitting', 'split-review', 'blocked'], rework),
      ),
    ).toThrow('workflow.taskStatuses must map manual: rule rework makes tasks')
  })

  it('refuses an execute rule unless every task status is mapped', () => {
    const raw = {
      workflow: stations(['refining', 'in-progress', 'in-review', 'blocked'], {
        taskStatuses: { 'to-do': 'T', manual: 'M', done: 'D' },
      }),
      rules: [
        {
          id: 'execute',
          watch: 'in-progress',
          agent: 'fake',
          mode: 'execute',
          outcomes: { succeeded: 'in-review', needs_input: 'blocked', blocked_manual: 'blocked' },
        },
      ],
    }
    expect(() => parse(raw)).toThrow(
      'workflow.taskStatuses must map in-progress, in-review: rule execute runs tasks',
    )
  })

  it('reads a custom rule with no prompt as no prompt, and maps every task status for it (D92)', () => {
    const custom = {
      id: 'custom',
      watch: 'in-progress',
      agent: 'fake',
      mode: 'custom',
      outcomes: { succeeded: 'in-review', done_for_now: 'in-review' },
    }
    expect(parse(withRules([custom])).rules[0]).toMatchObject({ mode: 'custom', prompt: '' })
    expect(() =>
      parse(withRules([{ ...custom, outcomes: { done_for_now: 'in-review' } }])),
    ).toThrow('rules[0] (custom).outcomes.succeeded is required in custom mode')
    expect(() =>
      parse({
        workflow: stations(['refining', 'in-progress', 'in-review', 'blocked'], {
          taskStatuses: { 'to-do': 'T', manual: 'M', done: 'D' },
        }),
        rules: [custom],
      }),
    ).toThrow('workflow.taskStatuses must map in-progress, in-review: rule custom runs tasks')
  })

  it('refuses two rules watching the same status, or with the same name', () => {
    expect(() => parse(withRules([split, { ...split, id: 'again' }]))).toThrow(
      'rules: split and again both watch ready-to-split',
    )
    expect(() => parse(withRules([split, { ...split, watch: 'refining' }]))).toThrow(
      'rules: two rules are called split',
    )
  })

  const splitStations = ['refining', 'ready-to-split', 'splitting', 'split-review', 'needs-answers']

  it('sends needs_input, failed and max_attempts to the failure station unless the rule says otherwise', () => {
    const raw = {
      workflow: stations(splitStations, { roles: { entry: 'refining', failure: 'refining' } }),
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
    }
    expect(
      parse(raw).rules.map((r) => [
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
    const raw = (rules: unknown[]) => ({
      workflow: stations([...splitStations, 'ready-to-rework', 'redo']),
      rules,
    })
    expect(parse(raw([split])).workflow.roles.rework).toBeUndefined()
    expect(parse(raw([split, rework])).workflow.roles.rework).toBe('ready-to-rework')
    expect(() => parse(raw([rework, { ...rework, id: 'again', watch: 'redo' }]))).toThrow(
      'rules: rework rules must watch one status, not ready-to-rework, redo',
    )
  })
})
