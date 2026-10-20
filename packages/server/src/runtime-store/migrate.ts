import type { DatabaseSync } from 'node:sqlite'

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get()
  return Number(row?.['user_version'] ?? 0)
}

// Migrations are append-only SQL strings. PRAGMA user_version records how many have run.
export function migrate(db: DatabaseSync, migrations: readonly string[]): number {
  const applied = schemaVersion(db)
  for (const [index, sql] of migrations.entries()) {
    if (index < applied) continue
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.exec(`PRAGMA user_version = ${index + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  return schemaVersion(db)
}
