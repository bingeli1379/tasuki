import { API_VERSION, definePlugin, type Plugin } from '@tasuki/core'
import { join } from 'node:path'
import { openDatabase } from './database'
import { migrate } from './migrate'
import { createSqliteTracker } from './tracker'
import { TRACKER_MIGRATIONS } from './tracker-migrations'

export * from './database'
export * from './migrate'
export * from './tracker-migrations'

const plugin: Plugin = definePlugin({
  name: '@tasuki/sqlite',
  apiVersion: API_VERSION,
  tracker: (ctx) => {
    // The file is fixed under dataDir (D46), so the plugin takes no options yet.
    const db = openDatabase(join(ctx.dataDir, 'tracker.db'))
    migrate(db, TRACKER_MIGRATIONS)
    return createSqliteTracker(ctx, db)
  },
})

export default plugin
