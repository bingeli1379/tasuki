import { describe, expect, it } from 'vite-plus/test'
import { openDatabase } from './database'
import { migrate, schemaVersion } from './migrate'

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
})
