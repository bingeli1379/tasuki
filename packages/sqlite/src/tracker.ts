import {
  EditConflict,
  InvalidInput,
  NotFound,
  StatusConflict,
  type Attachment,
  type Comment,
  type CommentAuthor,
  type CommentKind,
  type Kind,
  type Origin,
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
    ...(typeof row['parent'] === 'string' ? { parent: row['parent'] } : {}),
    title: String(row['title']),
    body: String(row['body']),
    status: ctx.statuses.fromTracker(kind, key) ?? key,
    labels: JSON.parse(String(row['labels'])) as string[],
    ...(typeof row['origin'] === 'string' ? { origin: row['origin'] as Origin } : {}),
    version: String(row['version']),
  }
}

function toComment(row: Row): Comment {
  return {
    id: String(row['id']),
    target: String(row['target']),
    author: row['author'] as CommentAuthor,
    ...(typeof row['author_name'] === 'string' ? { authorName: row['author_name'] } : {}),
    kind: row['kind'] as CommentKind,
    body: String(row['body']),
    createdAt: String(row['created_at']),
  }
}

const ATTACHMENT_COLUMNS = 'id, target, filename, mime_type, size, created_at'

function toAttachment(row: Row): Attachment {
  return {
    id: String(row['id']),
    target: String(row['target']),
    filename: String(row['filename']),
    mimeType: String(row['mime_type']),
    size: Number(row['size']),
    createdAt: String(row['created_at']),
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
    list(kind, statuses) {
      const keys = statuses.map((s) => ctx.statuses.toTracker(kind, s))
      const rows = db
        .prepare(
          `SELECT * FROM work_unit WHERE kind = ? AND status IN (${keys.map(() => '?').join(', ')}) ORDER BY rowid`,
        )
        .all(kind, ...keys)
      return Promise.resolve(rows.map((r) => toWorkUnit(ctx, r)))
    },
    // async so a throw becomes a rejection, like every other tracker.
    async get(ref) {
      return get(ref)
    },
    async children(item) {
      get(item)
      return db
        .prepare('SELECT * FROM work_unit WHERE parent = ? ORDER BY rowid')
        .all(item)
        .map((r) => toWorkUnit(ctx, r))
    },
    async dependencies(item) {
      get(item)
      return db
        .prepare(
          `SELECT d.task, d.blocked_by FROM dependency d JOIN work_unit t ON t.ref = d.task
           WHERE t.parent = ? ORDER BY t.rowid, d.blocked_by`,
        )
        .all(item)
        .map((r) => ({ task: String(r['task']), blockedBy: String(r['blocked_by']) }))
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
    async createTask(item, task) {
      if (get(item).kind !== 'item') throw new NotFound(`${item} is not an item`)
      const siblings = new Set(
        db
          .prepare('SELECT ref FROM work_unit WHERE parent = ?')
          .all(item)
          .map((r) => String(r['ref'])),
      )
      const foreign = task.blockedBy.filter((ref) => !siblings.has(ref))
      if (foreign.length > 0)
        throw new InvalidInput(`${foreign.join(', ')} is not a task of ${item}`)
      const now = ctx.clock.now().toISOString()
      const row = db
        .prepare(
          `INSERT INTO work_unit (ref, kind, parent, title, body, status, origin, created_at, updated_at)
           VALUES (? || '-' || (SELECT COALESCE(MAX(rowid), 0) + 1 FROM work_unit), 'task', ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`,
        )
        .get(
          refPrefix,
          item,
          task.title,
          task.body,
          ctx.statuses.toTracker('task', task.status),
          task.origin,
          now,
          now,
        )
      if (row === undefined) throw new Error('insert returned no row')
      const insert = db.prepare('INSERT INTO dependency (task, blocked_by) VALUES (?, ?)')
      for (const blocker of task.blockedBy) insert.run(row['ref'] as string, blocker)
      return toWorkUnit(ctx, row)
    },
    async transition(ref, expectedFrom, to) {
      const kind = get(ref).kind
      // The status check is in the same statement as the write, so this is a real
      // compare-and-set: a concurrent move makes this one update nothing.
      const row = db
        .prepare(
          `UPDATE work_unit SET status = ?, updated_at = ?, version = version + 1
           WHERE ref = ? AND status = ? RETURNING *`,
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
    async updateItem(ref, expectedVersion, patch) {
      get(ref)
      // Same compare-and-set as transition: the version check is in the write itself.
      const row = db
        .prepare(
          `UPDATE work_unit SET title = COALESCE(?, title), body = COALESCE(?, body),
             updated_at = ?, version = version + 1
           WHERE ref = ? AND version = ? RETURNING *`,
        )
        .get(
          patch.title ?? null,
          patch.body ?? null,
          ctx.clock.now().toISOString(),
          ref,
          Number(expectedVersion),
        )
      if (row === undefined) throw new EditConflict(get(ref))
      return toWorkUnit(ctx, row)
    },
    async comments(target) {
      get(target)
      return db
        .prepare('SELECT * FROM comment WHERE target = ? ORDER BY id')
        .all(target)
        .map(toComment)
    },
    async addComment(comment) {
      get(comment.target)
      const row = db
        .prepare(
          `INSERT INTO comment (target, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?)
           RETURNING *`,
        )
        .get(
          comment.target,
          comment.author,
          comment.kind,
          comment.body,
          ctx.clock.now().toISOString(),
        )
      if (row === undefined) throw new Error('insert returned no row')
      return toComment(row)
    },
    async attachments(target) {
      get(target)
      return db
        .prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachment WHERE target = ? ORDER BY id`)
        .all(target)
        .map(toAttachment)
    },
    async addAttachment(target, attachment) {
      get(target)
      const row = db
        .prepare(
          `INSERT INTO attachment (target, filename, mime_type, size, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING ${ATTACHMENT_COLUMNS}`,
        )
        .get(
          target,
          attachment.filename,
          attachment.mimeType,
          attachment.data.byteLength,
          attachment.data,
          ctx.clock.now().toISOString(),
        )
      if (row === undefined) throw new Error('insert returned no row')
      return toAttachment(row)
    },
    async readAttachment(target, id) {
      const row = db
        .prepare(`SELECT ${ATTACHMENT_COLUMNS}, data FROM attachment WHERE target = ? AND id = ?`)
        .get(target, Number(id))
      if (row === undefined) throw new NotFound(`${target} has no attachment ${id}`)
      return { attachment: toAttachment(row), data: new Uint8Array(row['data'] as Uint8Array) }
    },
  }
}
