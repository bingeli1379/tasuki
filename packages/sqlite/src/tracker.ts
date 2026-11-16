import type { Kind, PluginContext, StoragePort, WorkUnit } from '@tasuki/core'
import type { DatabaseSync } from 'node:sqlite'

type Row = Record<string, unknown>

function toWorkUnit(ctx: PluginContext, row: Row): WorkUnit {
  const kind = row['kind'] as Kind
  const key = String(row['status'])
  return {
    ref: String(row['ref']),
    kind,
    title: String(row['title']),
    body: String(row['body']),
    status: ctx.statuses.fromTracker(kind, key) ?? key,
    labels: JSON.parse(String(row['labels'])) as string[],
  }
}

// Status is stored as the tracker key from the mapping, the same way Jira holds its own status.
export function createSqliteTracker(
  ctx: PluginContext,
  db: DatabaseSync,
  refPrefix: string,
): StoragePort {
  return {
    list(kind, status) {
      const rows = db
        .prepare('SELECT * FROM work_unit WHERE kind = ? AND status = ? ORDER BY rowid')
        .all(kind, ctx.statuses.toTracker(kind, status))
      return Promise.resolve(rows.map((r) => toWorkUnit(ctx, r)))
    },
    createItem(item) {
      const now = ctx.clock.now().toISOString()
      // One statement, so two concurrent creates cannot get the same ref.
      const row = db
        .prepare(
          `INSERT INTO work_unit (ref, kind, title, body, status, created_at, updated_at)
           VALUES (? || '-' || (SELECT COALESCE(MAX(rowid), 0) + 1 FROM work_unit), 'item', ?, ?, ?, ?, ?)
           RETURNING *`,
        )
        .get(
          refPrefix,
          item.title,
          item.body,
          ctx.statuses.toTracker('item', item.status),
          now,
          now,
        )
      if (row === undefined) throw new Error('insert returned no row')
      return Promise.resolve(toWorkUnit(ctx, row))
    },
  }
}
