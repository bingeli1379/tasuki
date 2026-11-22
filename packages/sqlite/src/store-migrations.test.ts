import { describe, expect, it } from 'vite-plus/test'
import { openDatabase } from './database'
import { migrate } from './migrate'
import { STORE_MIGRATIONS } from './store-migrations'

describe('store migrations', () => {
  it('rebuilding the run table for S7d keeps every Run and its indexes', () => {
    const db = openDatabase(':memory:')
    migrate(db, STORE_MIGRATIONS.slice(0, 3))
    db.exec(`INSERT INTO run (id, target, rule, agent, attempt, workspace, state, outcome,
      lease_until, started_at, last_activity_at, log_path, produced_tasks, cancel_mode,
      cancel_requested_by) VALUES ('r1', 'T-1', 'split', 'fake', 2, '/w', 'finished',
      'cancelled', 'x', 'y', 'z', '/l', 3, 'hard', 'stop')`)
    migrate(db, STORE_MIGRATIONS)
    expect(db.prepare('SELECT * FROM run').get()).toMatchObject({
      id: 'r1',
      attempt: 2,
      produced_tasks: 3,
      cancel_mode: 'hard',
      cancel_requested_by: 'stop',
    })
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run'")
      .all()
      .map((r) => String(r['name']))
    expect(indexes).toEqual(expect.arrayContaining(['one_live_run', 'run_by_target']))
  })

  it('rebuilding the run table for W2 keeps every column and takes an outcome a rule named', () => {
    const db = openDatabase(':memory:')
    migrate(db, STORE_MIGRATIONS.slice(0, 6))
    db.exec(`INSERT INTO run (id, target, rule, agent, attempt, workspace, state, outcome,
      verdict, lease_until, started_at, last_activity_at, log_path, session_id, from_status,
      to_status) VALUES ('r1', 'T-1', 'split', 'fake', 1, '/w', 'finished', 'succeeded',
      'succeeded', 'x', 'y', 'z', '/l', 's1', 'ready-to-split', 'split-review')`)
    migrate(db, STORE_MIGRATIONS)
    expect(db.prepare('SELECT * FROM run').get()).toMatchObject({
      outcome: 'succeeded',
      session_id: 's1',
      from_status: 'ready-to-split',
      to_status: 'split-review',
    })
    db.exec(`UPDATE run SET outcome = 'approve', verdict = 'approve'`)
    expect(db.prepare('SELECT outcome FROM run').get()).toEqual({ outcome: 'approve' })
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run'")
      .all()
      .map((r) => String(r['name']))
    expect(indexes).toEqual(expect.arrayContaining(['one_live_run', 'run_by_target']))
  })

  it('dropping log_path for W3 keeps every Run', () => {
    const db = openDatabase(':memory:')
    migrate(
      db,
      STORE_MIGRATIONS.slice(0, STORE_MIGRATIONS.indexOf('ALTER TABLE run DROP COLUMN log_path;')),
    )
    db.exec(`INSERT INTO run (id, target, rule, agent, attempt, workspace, state, lease_until,
      started_at, last_activity_at, log_path) VALUES ('r1', 'T-1', 'split', 'fake', 1, '/w',
      'running', 'x', 'y', 'z', '/l')`)
    migrate(db, STORE_MIGRATIONS)
    const row = db.prepare('SELECT * FROM run').get()
    expect(row).toMatchObject({ id: 'r1', state: 'running' })
    expect(row).not.toHaveProperty('log_path')
  })
})
