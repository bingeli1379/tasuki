import { describe, expect, it } from 'vite-plus/test'
import { DEFAULT_FLOW } from './flow'
import { describeChanges } from './flow-changes'

const flow = (over: { statuses?: unknown[]; rules?: unknown[]; extra?: object } = {}) => ({
  workflow: {
    statuses: over.statuses ?? [
      { id: 'refining', outcomes: ['ready'] },
      { id: 'ready', name: 'Ready', key: '10001', outcomes: [] },
      { id: 'done', outcomes: [] },
    ],
    roles: { entry: 'refining', failure: 'done' },
    taskStatuses: { 'to-do': 'to-do', manual: 'manual' },
  },
  rules: over.rules ?? [
    { id: 'split', watch: 'ready', agent: 'fake', outcomes: { succeeded: 'done' } },
  ],
  labels: { hold: 'hold' },
  ...over.extra,
})
const rule = (over: object) => [
  {
    id: 'split',
    watch: 'ready',
    agent: 'fake',
    outcomes: { succeeded: 'done' },
    ...over,
  },
]

describe('describeChanges', () => {
  it('nothing changed lists nothing', () => {
    expect(describeChanges(flow(), flow())).toEqual([])
    expect(describeChanges(DEFAULT_FLOW, DEFAULT_FLOW)).toEqual([])
  })

  it.each([
    [
      'a status added and one removed, by display name and id',
      flow({
        statuses: [
          { id: 'refining', outcomes: ['ready'] },
          { id: 'ready', name: 'Ready', key: '10001', outcomes: [] },
          { id: 'ai-review', name: 'AI Review', outcomes: [] },
        ],
      }),
      ['Removed the status Done (done)', 'Added the status AI Review (ai-review)'],
    ],
    [
      'a status renamed, rekeyed, handed to a person and given other buttons',
      flow({
        statuses: [
          { id: 'refining', name: 'Inbox', outcomes: ['ready', 'done'] },
          { id: 'ready', name: 'Ready', key: '10002', handledBy: 'person', outcomes: [] },
          { id: 'done', outcomes: [] },
        ],
      }),
      [
        'Status refining name: Refining → Inbox',
        'Status refining buttons: ready → ready, done',
        'Status ready tracker status: 10001 → 10002',
        'Status ready now waits for a person',
      ],
    ],
    [
      'only the order moved',
      flow({
        statuses: [
          { id: 'ready', name: 'Ready', key: '10001', outcomes: [] },
          { id: 'refining', outcomes: ['ready'] },
          { id: 'done', outcomes: [] },
        ],
      }),
      ['New status order: ready, refining, done'],
    ],
    [
      'the roles, a task status and the hold label',
      {
        ...flow(),
        workflow: {
          ...flow().workflow,
          roles: { entry: 'ready', failure: 'refining' },
          taskStatuses: { 'to-do': 'to-do', done: 'done' },
        },
        labels: { hold: 'paused' },
      },
      [
        'New items start in: refining → ready',
        'When an agent fails, the item goes to: done → refining',
        'Task status Manual tracker status: manual → not used',
        'Task status Done tracker status: not used → done',
        'Hold label: hold → paused',
      ],
    ],
    [
      'a rule added and one removed',
      flow({
        rules: [{ id: 'review', watch: 'ready', agent: 'fake', outcomes: {} }],
      }),
      ['Removed the rule split', 'Added the rule review'],
    ],
    [
      'what a rule does, with defaults named as the form shows them',
      flow({
        rules: rule({
          watch: 'refining',
          claim: 'ready',
          needsFeedback: true,
          maxAttempts: 5,
          session: 'per-item',
          outcomes: { succeeded: 'ready', approve: 'done' },
        }),
      }),
      [
        'Rule split watches: ready → refining',
        'Rule split while working: leave it where it is → ready',
        'Rule split needs feedback: off → on',
        'Rule split attempts: default → 5',
        'Rule split session: fresh → per-item',
        'Rule split succeeded goes to: done → ready',
        'Rule split approve goes to: default → done',
      ],
    ],
  ])('%s', (_, after, texts) => {
    expect(describeChanges(flow(), after).map((c) => c.text)).toEqual(texts)
  })

  it('a prompt is told as changed, with both texts to show side by side', () => {
    const before = flow({ rules: rule({ prompt: 'Split it small.' }) })
    expect(describeChanges(before, flow())).toEqual([
      { text: 'Rule split prompt changed', before: 'Split it small.', after: '' },
    ])
  })
})
