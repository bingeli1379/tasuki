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
  // S5: what the agent made, for checking its verdict (agent-contract.md).
  `ALTER TABLE run ADD COLUMN produced_questions INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE run ADD COLUMN produced_tasks INTEGER NOT NULL DEFAULT 0;`,
  // S7c: a person asked the Run to stop (stop-and-recovery.md).
  `ALTER TABLE run ADD COLUMN cancel_requested_at TEXT;
  ALTER TABLE run ADD COLUMN cancel_mode TEXT CHECK (cancel_mode IN ('soft','hard'));
  ALTER TABLE run ADD COLUMN cancel_requested_by TEXT CHECK (cancel_requested_by IN ('stop','hold','moved'));`,
  // S7d: the global pause, and pause as a cancel reason. SQLite cannot change a CHECK in
  // place, so run is rebuilt (its documented way: new table, copy, drop, rename).
  `CREATE TABLE engine_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE run_next (
    id                  TEXT PRIMARY KEY,
    target              TEXT NOT NULL,
    rule                TEXT NOT NULL,
    agent               TEXT NOT NULL,
    attempt             INTEGER NOT NULL,
    workspace           TEXT NOT NULL,
    state               TEXT NOT NULL CHECK (state IN ('running','finished')),
    outcome             TEXT CHECK (outcome IN
      ('succeeded','needs_input','blocked_manual','failed','max_attempts','cancelled','abandoned')),
    verdict             TEXT CHECK (verdict IN ('succeeded','needs_input','blocked_manual','failed')),
    summary             TEXT,
    lease_until         TEXT NOT NULL,
    started_at          TEXT NOT NULL,
    last_activity_at    TEXT NOT NULL,
    finished_at         TEXT,
    log_path            TEXT NOT NULL,
    produced_questions  INTEGER NOT NULL DEFAULT 0,
    produced_tasks      INTEGER NOT NULL DEFAULT 0,
    cancel_requested_at TEXT,
    cancel_mode         TEXT CHECK (cancel_mode IN ('soft','hard')),
    cancel_requested_by TEXT CHECK (cancel_requested_by IN ('stop','hold','moved','pause'))
  );
  INSERT INTO run_next SELECT id, target, rule, agent, attempt, workspace, state, outcome,
    verdict, summary, lease_until, started_at, last_activity_at, finished_at, log_path,
    produced_questions, produced_tasks, cancel_requested_at, cancel_mode, cancel_requested_by
    FROM run;
  DROP TABLE run;
  ALTER TABLE run_next RENAME TO run;
  CREATE UNIQUE INDEX one_live_run ON run(target) WHERE state = 'running';
  CREATE INDEX run_by_target ON run(target, started_at DESC);`,
  // S8: the agent session a Run ran in, for the next Run on the item to resume.
  `ALTER TABLE run ADD COLUMN session_id TEXT;`,
  // D82: where the item was claimed from and where the engine moved it, as they were then.
  `ALTER TABLE run ADD COLUMN from_status TEXT;
  ALTER TABLE run ADD COLUMN to_status TEXT;`,
]
