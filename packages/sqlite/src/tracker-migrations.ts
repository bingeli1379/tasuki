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
  // S3: item detail. version is the edit token (EditConflict), bumped by every write.
  `ALTER TABLE work_unit ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE comment (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target      TEXT NOT NULL REFERENCES work_unit(ref),
    author      TEXT NOT NULL CHECK (author IN ('human','agent','engine')),
    author_name TEXT,
    kind        TEXT NOT NULL CHECK (kind IN ('note','question','system')),
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX comment_by_target ON comment(target, id);
  CREATE TABLE attachment (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    target     TEXT NOT NULL REFERENCES work_unit(ref),
    filename   TEXT NOT NULL,
    mime_type  TEXT NOT NULL,
    size       INTEGER NOT NULL,
    data       BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX attachment_by_target ON attachment(target, id);`,
  // S5: tasks. work_unit already has parent and origin.
  `CREATE INDEX work_unit_by_parent ON work_unit(parent);
  CREATE TABLE dependency (
    task       TEXT NOT NULL REFERENCES work_unit(ref),
    blocked_by TEXT NOT NULL REFERENCES work_unit(ref),
    PRIMARY KEY (task, blocked_by)
  );`,
]
