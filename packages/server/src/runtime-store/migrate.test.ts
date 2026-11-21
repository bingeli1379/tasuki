import { describe, expect, it } from 'vite-plus/test'
import { openDatabase } from './database'
import { migrate, schemaVersion } from './migrate'
import { RUNTIME_MIGRATIONS } from './migrations'

const tables = (db: ReturnType<typeof openDatabase>): string[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => String(r['name']))

describe('migrate', () => {
  it('a fresh database is at version 0', () => {
    expect(schemaVersion(openDatabase(':memory:'))).toBe(0)
  })

  it('applies each migration once, in order', () => {
    const db = openDatabase(':memory:')
    const migrations = ['CREATE TABLE a (id INTEGER)', 'CREATE TABLE b (id INTEGER)']
    expect(migrate(db, migrations)).toBe(2)
    expect(tables(db)).toEqual(['a', 'b'])
  })

  it('running again changes nothing, and a new migration is picked up', () => {
    const db = openDatabase(':memory:')
    migrate(db, ['CREATE TABLE a (id INTEGER)'])
    expect(migrate(db, ['CREATE TABLE a (id INTEGER)'])).toBe(1)
    expect(migrate(db, ['CREATE TABLE a (id INTEGER)', 'CREATE TABLE b (id INTEGER)'])).toBe(2)
    expect(tables(db)).toEqual(['a', 'b'])
  })

  it('a failing migration rolls back and leaves the version where it was', () => {
    const db = openDatabase(':memory:')
    expect(() =>
      migrate(db, ['CREATE TABLE a (id INTEGER)', 'CREATE TABLE b (id INTEGER); NOT SQL']),
    ).toThrow()
    expect(schemaVersion(db)).toBe(1)
    expect(tables(db)).toEqual(['a'])
  })

  it('rebuilding the run table for S7d keeps every Run and its indexes', () => {
    const db = openDatabase(':memory:')
    migrate(db, RUNTIME_MIGRATIONS.slice(0, 3))
    db.exec(`INSERT INTO run (id, target, rule, agent, attempt, workspace, state, outcome,
      lease_until, started_at, last_activity_at, log_path, produced_tasks, cancel_mode,
      cancel_requested_by) VALUES ('r1', 'T-1', 'split', 'fake', 2, '/w', 'finished',
      'cancelled', 'x', 'y', 'z', '/l', 3, 'hard', 'stop')`)
    migrate(db, RUNTIME_MIGRATIONS)
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
    migrate(db, RUNTIME_MIGRATIONS.slice(0, 6))
    db.exec(`INSERT INTO run (id, target, rule, agent, attempt, workspace, state, outcome,
      verdict, lease_until, started_at, last_activity_at, log_path, session_id, from_status,
      to_status) VALUES ('r1', 'T-1', 'split', 'fake', 1, '/w', 'finished', 'succeeded',
      'succeeded', 'x', 'y', 'z', '/l', 's1', 'ready-to-split', 'split-review')`)
    migrate(db, RUNTIME_MIGRATIONS)
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
})
