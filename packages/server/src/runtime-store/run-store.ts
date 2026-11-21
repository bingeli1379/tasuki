import {
  InvalidInput,
  NotFound,
  RunConflict,
  type CancelMode,
  type CancelReason,
  type Clock,
  type Outcome,
  type Run,
  type RuntimeStorePort,
  type Verdict,
} from '@tasuki/core'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

type Row = Record<string, unknown>

const optional = <K extends string>(key: K, value: unknown): Partial<Record<K, string>> =>
  typeof value === 'string' ? ({ [key]: value } as Record<K, string>) : {}

function toRun(row: Row): Run {
  return {
    id: String(row['id']),
    target: String(row['target']),
    rule: String(row['rule']),
    agent: String(row['agent']),
    attempt: Number(row['attempt']),
    ...optional('sessionId', row['session_id']),
    workspace: String(row['workspace']),
    state: row['state'] as Run['state'],
    ...(optional('outcome', row['outcome']) as { outcome?: Outcome }),
    ...(optional('verdict', row['verdict']) as { verdict?: Verdict }),
    ...optional('summary', row['summary']),
    produced: {
      questions: Number(row['produced_questions']),
      tasks: Number(row['produced_tasks']),
    },
    ...optional('cancelRequestedAt', row['cancel_requested_at']),
    ...(optional('cancelMode', row['cancel_mode']) as { cancelMode?: CancelMode }),
    ...(optional('cancelRequestedBy', row['cancel_requested_by']) as {
      cancelRequestedBy?: CancelReason
    }),
    leaseUntil: String(row['lease_until']),
    startedAt: String(row['started_at']),
    lastActivityAt: String(row['last_activity_at']),
    ...optional('finishedAt', row['finished_at']),
    logPath: String(row['log_path']),
  }
}

// rowid breaks ties: a fake clock can start two Runs in the same millisecond.
const NEWEST_FIRST = 'ORDER BY started_at DESC, rowid DESC'

export function createRuntimeStore(
  db: DatabaseSync,
  clock: Clock,
  logDir: string,
): RuntimeStorePort {
  const later = (seconds: number): string =>
    new Date(clock.now().getTime() + seconds * 1000).toISOString()

  function get(id: string): Run {
    const row = db.prepare('SELECT * FROM run WHERE id = ?').get(id)
    if (row === undefined) throw new NotFound(`Run ${id} does not exist`)
    return toRun(row)
  }

  return {
    async createRun(run) {
      const id = randomUUID()
      const now = clock.now().toISOString()
      try {
        db.prepare(
          `INSERT INTO run (id, target, rule, agent, attempt, workspace, state, lease_until,
             started_at, last_activity_at, log_path)
           VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
        ).run(
          id,
          run.target,
          run.rule,
          run.agent,
          run.attempt,
          run.workspace,
          later(run.leaseSeconds),
          now,
          now,
          join(logDir, `${id}.log`),
        )
      } catch (e) {
        if (e instanceof Error && e.message.includes('UNIQUE constraint failed'))
          throw new RunConflict(`${run.target} already has a live Run`)
        throw e
      }
      return get(id)
    },
    async getRun(id) {
      return get(id)
    },
    async renewLease(id, leaseSeconds) {
      db.prepare("UPDATE run SET lease_until = ? WHERE id = ? AND state = 'running'").run(
        later(leaseSeconds),
        id,
      )
    },
    async touch(id) {
      db.prepare("UPDATE run SET last_activity_at = ? WHERE id = ? AND state = 'running'").run(
        clock.now().toISOString(),
        id,
      )
    },
    async recordSession(id, sessionId) {
      db.prepare('UPDATE run SET session_id = ? WHERE id = ?').run(sessionId, id)
    },
    async report(id, verdict, summary) {
      const { changes } = db
        .prepare(
          "UPDATE run SET verdict = ?, summary = ? WHERE id = ? AND state = 'running' AND verdict IS NULL",
        )
        .run(verdict, summary, id)
      if (changes === 0) {
        const run = get(id)
        throw new InvalidInput(
          run.state === 'finished' ? 'this Run is over' : 'the result was already reported',
        )
      }
    },
    async bumpProduced(id, key) {
      const column = key === 'questions' ? 'produced_questions' : 'produced_tasks'
      db.prepare(`UPDATE run SET ${column} = ${column} + 1 WHERE id = ?`).run(id)
    },
    async finishRun(id, outcome) {
      db.prepare(
        "UPDATE run SET state = 'finished', outcome = ?, finished_at = ? WHERE id = ? AND state = 'running'",
      ).run(outcome, clock.now().toISOString(), id)
    },
    async requestCancel(id, mode, by) {
      db.prepare(
        `UPDATE run SET cancel_requested_at = COALESCE(cancel_requested_at, ?1),
           cancel_requested_by = CASE
             WHEN cancel_mode = 'hard' THEN cancel_requested_by
             WHEN ?2 = 'hard' THEN ?3
             ELSE COALESCE(cancel_requested_by, ?3) END,
           cancel_mode = CASE WHEN cancel_mode = 'hard' THEN 'hard' ELSE ?2 END
         WHERE id = ?4 AND state = 'running'`,
      ).run(clock.now().toISOString(), mode, by, id)
    },
    async isPaused() {
      return db.prepare("SELECT 1 FROM engine_state WHERE key = 'paused'").get() !== undefined
    },
    async setPaused(paused) {
      if (paused) db.prepare("INSERT OR IGNORE INTO engine_state VALUES ('paused', 'true')").run()
      else db.prepare("DELETE FROM engine_state WHERE key = 'paused'").run()
    },
    async liveRuns() {
      return db
        .prepare(`SELECT * FROM run WHERE state = 'running' ${NEWEST_FIRST}`)
        .all()
        .map(toRun)
    },
    async runsFor(target) {
      return db.prepare(`SELECT * FROM run WHERE target = ? ${NEWEST_FIRST}`).all(target).map(toRun)
    },
    async latestRunsEndedIn(outcome) {
      return db
        .prepare(
          `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY target ${NEWEST_FIRST}) AS n FROM run)
           WHERE n = 1 AND outcome = ?`,
        )
        .all(outcome)
        .map(toRun)
    },
  }
}
