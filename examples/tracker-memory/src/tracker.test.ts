import {
  createStatusMap,
  DEFAULT_WORKFLOW,
  TASK_STATUS_DISPLAY,
  type PluginContext,
} from '@tasuki/core'
import { describeTrackerContract } from '@tasuki/testkit'
import { expect, it } from 'vitest'
import plugin from './index.js'

// The status keys the contract needs, mapped the way a config's `statuses` would.
const ctx: PluginContext = {
  clock: { now: () => new Date() },
  configDir: '',
  dataDir: '',
  statuses: createStatusMap({
    item: Object.fromEntries(DEFAULT_WORKFLOW.statuses.map((s) => [s.id, s.name])),
    task: TASK_STATUS_DISPLAY,
  }),
}

describeTrackerContract('memory', async () => ({ tracker: await plugin.tracker!(ctx, {}) }))

it('refuses a ref prefix that is not upper-case', () => {
  expect(() => plugin.tracker!(ctx, { refPrefix: 'mem' })).toThrow('options.refPrefix')
})
