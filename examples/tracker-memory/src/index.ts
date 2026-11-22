import { definePlugin, type Plugin } from '@tasuki/core'
import { createMemoryTracker } from './tracker.js'

const plugin: Plugin = definePlugin({
  name: 'tasuki-plugin-memory',
  apiVersion: 1,
  tracker: (ctx, options) => {
    // The engine hands options over untouched: checking them is the plugin's job.
    const { refPrefix = 'MEM' } = (options ?? {}) as { refPrefix?: unknown }
    if (typeof refPrefix !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(refPrefix))
      throw new Error('options.refPrefix must be upper-case letters and digits, e.g. "MEM"')
    return createMemoryTracker(ctx, refPrefix)
  },
})

export default plugin
