import { API_VERSION, definePlugin, type Plugin } from '@tasuki/core'
import { join } from 'node:path'
import { openDatabase } from './database'
import { migrate } from './migrate'
import { createSqliteTracker } from './tracker'
import { TRACKER_MIGRATIONS } from './tracker-migrations'

export * from './database'
export * from './migrate'
export * from './tracker'
export * from './tracker-migrations'

const plugin: Plugin = definePlugin({
  name: '@tasuki/sqlite',
  apiVersion: API_VERSION,
  tracker: (ctx, options) => {
    const refPrefix = (options as { refPrefix?: unknown }).refPrefix ?? 'TSK'
    // Same shape as a Jira project key, so refs stay safe in URLs and JQL-like filters.
    if (typeof refPrefix !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(refPrefix)) {
      throw new Error(
        'options.refPrefix must be uppercase letters and digits, starting with a letter',
      )
    }
    // The file is fixed under dataDir (D46).
    const db = openDatabase(join(ctx.dataDir, 'tracker.db'))
    migrate(db, TRACKER_MIGRATIONS)
    return createSqliteTracker(ctx, db, refPrefix)
  },
})

export default plugin
