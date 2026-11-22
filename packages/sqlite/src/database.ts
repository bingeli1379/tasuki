import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  // `tasuki pause` writes the store while the engine holds it open: wait out its write lock
  // instead of failing with SQLITE_BUSY.
  const db = new DatabaseSync(path, { timeout: 5000 })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}
