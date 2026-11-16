export const TRACKER_MIGRATIONS: readonly string[] = [
  `CREATE TABLE work_unit (
    ref        TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('item','task')),
    parent     TEXT REFERENCES work_unit(ref),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL,
    assignee   TEXT,
    labels     TEXT NOT NULL DEFAULT '[]',
    origin     TEXT CHECK (origin IN ('refine','splitter','human')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
]
