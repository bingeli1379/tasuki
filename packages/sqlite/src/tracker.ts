import {
  NotFound,
  StatusConflict,
  type Kind,
  type PluginContext,
  type StoragePort,
  type WorkUnit,
} from '@tasuki/core'
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
  function get(ref: string): WorkUnit {
    const row = db.prepare('SELECT * FROM work_unit WHERE ref = ?').get(ref)
    if (row === undefined) throw new NotFound(`${ref} does not exist`)
    return toWorkUnit(ctx, row)
  }

  return {
    list(kind, status) {
      const rows = db
        .prepare('SELECT * FROM work_unit WHERE kind = ? AND status = ? ORDER BY rowid')
        .all(kind, ctx.statuses.toTracker(kind, status))
      return Promise.resolve(rows.map((r) => toWorkUnit(ctx, r)))
    },
    // async so a throw becomes a rejection, like every other tracker.
    async get(ref) {
      return get(ref)
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
    async transition(ref, expectedFrom, to) {
      const kind = get(ref).kind
      // The status check is in the same statement as the write, so this is a real
      // compare-and-set: a concurrent move makes this one update nothing.
      const row = db
        .prepare(
          `UPDATE work_unit SET status = ?, updated_at = ? WHERE ref = ? AND status = ? RETURNING *`,
        )
        .get(
          ctx.statuses.toTracker(kind, to),
          ctx.clock.now().toISOString(),
          ref,
          ctx.statuses.toTracker(kind, expectedFrom),
        )
      if (row === undefined) throw new StatusConflict(expectedFrom, get(ref))
      return toWorkUnit(ctx, row)
    },
  }
}
