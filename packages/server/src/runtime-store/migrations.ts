export const RUNTIME_MIGRATIONS: readonly string[] = [
  // S4. Columns for cancel, session, produced and usage arrive with the slices that use them.
  `CREATE TABLE run (
    id               TEXT PRIMARY KEY,
    target           TEXT NOT NULL,
    rule             TEXT NOT NULL,
    agent            TEXT NOT NULL,
    attempt          INTEGER NOT NULL,
    workspace        TEXT NOT NULL,
    state            TEXT NOT NULL CHECK (state IN ('running','finished')),
    outcome          TEXT CHECK (outcome IN
      ('succeeded','needs_input','blocked_manual','failed','max_attempts','cancelled','abandoned')),
    verdict          TEXT CHECK (verdict IN ('succeeded','needs_input','blocked_manual','failed')),
    summary          TEXT,
    lease_until      TEXT NOT NULL,
    started_at       TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    finished_at      TEXT,
    log_path         TEXT NOT NULL
  );
  -- invariant 1: at most one live Run per target
  CREATE UNIQUE INDEX one_live_run ON run(target) WHERE state = 'running';
  CREATE INDEX run_by_target ON run(target, started_at DESC);`,
]
