import type { Access, Account } from '../../domain/account'
import type { CancelMode, CancelReason, Outcome, Run, Verdict } from '../../domain/run'
import type { Ref } from '../../domain/work-unit'

export interface NewRun {
  target: Ref
  item: Ref
  rule: string
  agent: string
  attempt: number
  // The status the item was claimed from.
  from: string
  workspace: string
  leaseSeconds: number
}

export interface NewAccount {
  // The store makes one when left out.
  userId?: string
  username: string
  displayName: string
  access: Access
  // Only for accounts the store keeps the password of (auth-builtin).
  passwordHash?: string
  externalId?: string
}

export interface AccountChange {
  displayName?: string
  access?: Access
  disabled?: boolean
  externalId?: string
}

export interface Session {
  userId: string
  // The ttl it was issued under: once the config says otherwise it is over (D89).
  ttl: string
  // Unset when the ttl is never.
  expiresAt?: string
  createdAt: string
}

// One save of the flow settings (D91). The store keeps them as given; the engine checks them.
export interface FlowVersion {
  version: number
  flow: unknown
  // The name of whoever saved it, copied at the time; empty when nobody signs in.
  savedBy: string
  savedAt: string
}

export interface ApiToken {
  id: string
  userId: string
  name: string
  expiresAt?: string
  createdAt: string
}

// The engine's own state: Runs, the global pause, the flow settings, and who may sign in with what. A plugin role, like the tracker (D78).
// The store stamps every time from the Clock.
export interface StorePort {
  // Throws RunConflict when the target already has a live Run (invariant 1).
  createRun(run: NewRun): Promise<Run>
  // Throws NotFound for an unknown id.
  getRun(id: string): Promise<Run>
  renewLease(id: string, leaseSeconds: number): Promise<void>
  // The agent did something: lastActivityAt becomes now.
  touch(id: string): Promise<void>
  recordSession(id: string, sessionId: string): Promise<void>
  // Keeps the first report; throws InvalidInput on a second one or once the Run is over.
  report(id: string, verdict: Verdict, summary: string): Promise<void>
  // Counts what the agent made, for checking its verdict later.
  bumpProduced(id: string, key: 'questions' | 'tasks'): Promise<void>
  // to: where the engine moved the item, when it moved it.
  finishRun(id: string, outcome: Outcome, to?: string): Promise<void>
  // Only on a live Run. The first request's time stays. A later hard one turns a soft cancel
  // hard, and its reason replaces the soft one's: it is what ended the Run, e.g. Stop pressed
  // while the hold label it sets was already seen. Nothing turns a hard cancel back.
  requestCancel(id: string, mode: CancelMode, by: CancelReason): Promise<void>
  liveRuns(): Promise<Run[]>
  // Newest first.
  runsFor(target: Ref): Promise<Run[]>
  // The global pause (stop-and-recovery.md). Survives a restart.
  isPaused(): Promise<boolean>
  setPaused(paused: boolean): Promise<void>
  // The newest Run of each target, where that Run ended in outcome.
  latestRunsEndedIn(outcome: Outcome): Promise<Run[]>

  // Undefined until the first save.
  latestFlow(): Promise<FlowVersion | undefined>
  // Compare-and-set on the version latestFlow gave, undefined before the first save. Throws
  // FlowConflict when another save came in between. Versions count up from 1.
  saveFlow(expected: number | undefined, flow: unknown, savedBy: string): Promise<FlowVersion>
  // Every save, newest first.
  flowHistory(): Promise<FlowVersion[]>

  // Throws InvalidInput when the userId, the username or the externalId is taken.
  createAccount(account: NewAccount): Promise<Account>
  getAccount(userId: string): Promise<Account | undefined>
  findAccount(username: string): Promise<Account | undefined>
  findAccountByExternalId(externalId: string): Promise<Account | undefined>
  // Oldest first.
  listAccounts(): Promise<Account[]>
  // Throws NotFound for an unknown userId.
  updateAccount(userId: string, change: AccountChange): Promise<Account>
  passwordHash(userId: string): Promise<string | undefined>
  setPasswordHash(userId: string, hash: string): Promise<void>
  // With its sessions and API tokens. What it wrote keeps the name it was written under.
  deleteAccount(userId: string): Promise<void>

  // Tokens are kept by their hash only; the token itself is never stored.
  createSession(tokenHash: string, session: Omit<Session, 'createdAt'>): Promise<void>
  getSession(tokenHash: string): Promise<Session | undefined>
  deleteSession(tokenHash: string): Promise<void>
  createApiToken(tokenHash: string, token: Omit<ApiToken, 'id' | 'createdAt'>): Promise<ApiToken>
  apiTokenByHash(tokenHash: string): Promise<ApiToken | undefined>
  // Oldest first.
  apiTokensOf(userId: string): Promise<ApiToken[]>
  deleteApiToken(id: string): Promise<void>
}
