import {
  InvalidInput,
  NotFound,
  RunConflict,
  type Access,
  type Account,
  type ApiToken,
  type CancelMode,
  type CancelReason,
  type Clock,
  type Outcome,
  type Run,
  type StorePort,
  type Verdict,
} from '@tasuki/core'
import { randomUUID } from 'node:crypto'
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
    ...optional('from', row['from_status']),
    ...optional('to', row['to_status']),
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
  }
}

function toAccount(row: Row): Account {
  return {
    userId: String(row['user_id']),
    username: String(row['username']),
    displayName: String(row['display_name']),
    access: row['access'] as Access,
    disabled: row['disabled_at'] !== null,
    createdAt: String(row['created_at']),
  }
}

function toApiToken(row: Row): ApiToken {
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    name: String(row['name']),
    ...optional('expiresAt', row['expires_at']),
    createdAt: String(row['created_at']),
  }
}

// rowid breaks ties: a fake clock can start two Runs in the same millisecond.
const NEWEST_FIRST = 'ORDER BY started_at DESC, rowid DESC'

export function createSqliteStore(db: DatabaseSync, clock: Clock): StorePort {
  const later = (seconds: number): string =>
    new Date(clock.now().getTime() + seconds * 1000).toISOString()

  function account(userId: string): Account | undefined {
    const row = db.prepare('SELECT * FROM account WHERE user_id = ?').get(userId)
    return row === undefined ? undefined : toAccount(row)
  }

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
          `INSERT INTO run (id, target, rule, agent, attempt, from_status, workspace, state,
             lease_until, started_at, last_activity_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
        ).run(
          id,
          run.target,
          run.rule,
          run.agent,
          run.attempt,
          run.from,
          run.workspace,
          later(run.leaseSeconds),
          now,
          now,
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
    async finishRun(id, outcome, to) {
      db.prepare(
        "UPDATE run SET state = 'finished', outcome = ?, finished_at = ?, to_status = ? WHERE id = ? AND state = 'running'",
      ).run(outcome, clock.now().toISOString(), to ?? null, id)
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
    async createAccount(a) {
      try {
        db.prepare(
          `INSERT INTO account (user_id, username, display_name, access, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          a.userId,
          a.username,
          a.displayName,
          a.access,
          a.passwordHash ?? null,
          clock.now().toISOString(),
        )
      } catch (e) {
        if (e instanceof Error && e.message.includes('UNIQUE constraint failed'))
          throw new InvalidInput(`the username ${a.username} is taken`)
        throw e
      }
      return account(a.userId) as Account
    },
    async getAccount(userId) {
      return account(userId)
    },
    async findAccount(username) {
      const row = db.prepare('SELECT * FROM account WHERE username = ?').get(username)
      return row === undefined ? undefined : toAccount(row)
    },
    async listAccounts() {
      return db.prepare('SELECT * FROM account ORDER BY created_at, rowid').all().map(toAccount)
    },
    async updateAccount(userId, change) {
      if (account(userId) === undefined) throw new NotFound(`no account ${userId}`)
      if (change.displayName !== undefined)
        db.prepare('UPDATE account SET display_name = ? WHERE user_id = ?').run(
          change.displayName,
          userId,
        )
      if (change.access !== undefined)
        db.prepare('UPDATE account SET access = ? WHERE user_id = ?').run(change.access, userId)
      if (change.disabled !== undefined)
        db.prepare(
          'UPDATE account SET disabled_at = CASE WHEN ? THEN COALESCE(disabled_at, ?) END WHERE user_id = ?',
        ).run(change.disabled ? 1 : 0, clock.now().toISOString(), userId)
      return account(userId) as Account
    },
    async passwordHash(userId) {
      const row = db.prepare('SELECT password_hash FROM account WHERE user_id = ?').get(userId)
      const hash = row?.['password_hash']
      return typeof hash === 'string' ? hash : undefined
    },
    async setPasswordHash(userId, hash) {
      db.prepare('UPDATE account SET password_hash = ? WHERE user_id = ?').run(hash, userId)
    },
    async createSession(tokenHash, session) {
      db.prepare(
        'INSERT INTO session (token_hash, user_id, ttl, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(
        tokenHash,
        session.userId,
        session.ttl,
        session.expiresAt ?? null,
        clock.now().toISOString(),
      )
    },
    async getSession(tokenHash) {
      const row = db.prepare('SELECT * FROM session WHERE token_hash = ?').get(tokenHash)
      if (row === undefined) return undefined
      return {
        userId: String(row['user_id']),
        ttl: String(row['ttl']),
        ...optional('expiresAt', row['expires_at']),
        createdAt: String(row['created_at']),
      }
    },
    async deleteSession(tokenHash) {
      db.prepare('DELETE FROM session WHERE token_hash = ?').run(tokenHash)
    },
    async createApiToken(tokenHash, token) {
      const id = randomUUID()
      db.prepare(
        'INSERT INTO api_token (id, user_id, name, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        token.userId,
        token.name,
        tokenHash,
        token.expiresAt ?? null,
        clock.now().toISOString(),
      )
      return toApiToken(db.prepare('SELECT * FROM api_token WHERE id = ?').get(id) as Row)
    },
    async apiTokenByHash(tokenHash) {
      const row = db.prepare('SELECT * FROM api_token WHERE token_hash = ?').get(tokenHash)
      return row === undefined ? undefined : toApiToken(row)
    },
    async apiTokensOf(userId) {
      return db
        .prepare('SELECT * FROM api_token WHERE user_id = ? ORDER BY rowid')
        .all(userId)
        .map(toApiToken)
    },
    async deleteApiToken(id) {
      db.prepare('DELETE FROM api_token WHERE id = ?').run(id)
    },
  }
}
