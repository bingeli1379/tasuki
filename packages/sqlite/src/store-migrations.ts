export const STORE_MIGRATIONS: readonly string[] = [
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
  // W2: a rule names its own outcomes, so outcome and verdict lose their fixed lists; the
  // config checks them instead. Rebuilt as in S7d.
  `CREATE TABLE run_next (
    id                  TEXT PRIMARY KEY,
    target              TEXT NOT NULL,
    rule                TEXT NOT NULL,
    agent               TEXT NOT NULL,
    attempt             INTEGER NOT NULL,
    workspace           TEXT NOT NULL,
    state               TEXT NOT NULL CHECK (state IN ('running','finished')),
    outcome             TEXT,
    verdict             TEXT,
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
    cancel_requested_by TEXT CHECK (cancel_requested_by IN ('stop','hold','moved','pause')),
    session_id          TEXT,
    from_status         TEXT,
    to_status           TEXT
  );
  INSERT INTO run_next SELECT id, target, rule, agent, attempt, workspace, state, outcome,
    verdict, summary, lease_until, started_at, last_activity_at, finished_at, log_path,
    produced_questions, produced_tasks, cancel_requested_at, cancel_mode, cancel_requested_by,
    session_id, from_status, to_status
    FROM run;
  DROP TABLE run;
  ALTER TABLE run_next RENAME TO run;
  CREATE UNIQUE INDEX one_live_run ON run(target) WHERE state = 'running';
  CREATE INDEX run_by_target ON run(target, started_at DESC);`,
  // W3: the engine names a Run's log file itself; a store on another machine cannot see it.
  `ALTER TABLE run DROP COLUMN log_path;`,
  // S9 (D89): accounts with their access, sessions and personal API tokens, by hash only.
  `CREATE TABLE account (
    user_id       TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    access        TEXT NOT NULL CHECK (access IN ('admin','maintainer','member')),
    password_hash TEXT,
    disabled_at   TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE session (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES account(user_id),
    ttl        TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE api_token (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES account(user_id),
    name       TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX api_token_by_user ON api_token(user_id);`,
  // S9c (D90): who the outside system says an account is, bound at its first sign in.
  `ALTER TABLE account ADD COLUMN external_id TEXT;
  CREATE UNIQUE INDEX account_by_external_id ON account(external_id);`,
  // W4a (D91): every save of the flow settings, as JSON the engine checks, newest the one in use.
  `CREATE TABLE flow_version (
    version  INTEGER PRIMARY KEY,
    flow     TEXT NOT NULL,
    saved_by TEXT NOT NULL,
    saved_at TEXT NOT NULL
  );`,
  // S13 (D102): the item a Run works for, which for a dispatched task is not its target.
  `ALTER TABLE run ADD COLUMN item TEXT NOT NULL DEFAULT '';
  UPDATE run SET item = target;`,
  // W5 (D104): the station of an item whose tracker status several stations share.
  `CREATE TABLE item_status (
    ref    TEXT PRIMARY KEY,
    status TEXT NOT NULL
  );`,
  // W6a (D105): the instance's settings join the flow's, each document versioned on its own.
  `CREATE TABLE settings_version (
    doc      TEXT NOT NULL,
    version  INTEGER NOT NULL,
    value    TEXT NOT NULL,
    saved_by TEXT NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (doc, version)
  );
  INSERT INTO settings_version SELECT 'flow', version, flow, saved_by, saved_at FROM flow_version;
  DROP TABLE flow_version;`,
  // W8 (D107): what the agent's CLI refused it, as JSON, once the Run is over.
  `ALTER TABLE run ADD COLUMN denials TEXT;`,
]
