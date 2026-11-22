import { InvalidInput, type Account, type ApiToken, type Clock, type StorePort } from '@tasuki/core'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const newToken = (): string => randomBytes(32).toString('base64url')
const hashOf = (token: string): string => createHash('sha256').update(token).digest('base64url')

export interface SessionTtl {
  ttl: string
  // Unset for never.
  ttlSeconds?: number
}

// Sessions for the board and personal API tokens for /mcp. The store keeps their hashes only;
// a disabled account's are refused on every request (security-and-auth.md).
export interface SignIns {
  start(userId: string): Promise<string>
  resolve(token: string): Promise<Account | undefined>
  end(token: string): Promise<void>
  issueApiToken(
    userId: string,
    name: string,
    expiresAt?: string,
  ): Promise<{ token: string; apiToken: ApiToken }>
  resolveApiToken(token: string): Promise<Account | undefined>
}

export function createSignIns(store: StorePort, clock: Clock, session: SessionTtl): SignIns {
  const expired = (at: string | undefined): boolean =>
    at !== undefined && Date.parse(at) <= clock.now().getTime()

  async function active(userId: string): Promise<Account | undefined> {
    const account = await store.getAccount(userId)
    return account?.disabled === false ? account : undefined
  }

  return {
    async start(userId) {
      const token = newToken()
      await store.createSession(hashOf(token), {
        userId,
        ttl: session.ttl,
        ...(session.ttlSeconds === undefined
          ? {}
          : {
              expiresAt: new Date(clock.now().getTime() + session.ttlSeconds * 1000).toISOString(),
            }),
      })
      return token
    },
    async resolve(token) {
      const hash = hashOf(token)
      const found = await store.getSession(hash)
      if (found === undefined) return undefined
      // A changed ttl ends every session issued under the old one (D89).
      if (found.ttl !== session.ttl || expired(found.expiresAt)) {
        await store.deleteSession(hash)
        return undefined
      }
      return active(found.userId)
    },
    async end(token) {
      await store.deleteSession(hashOf(token))
    },
    async issueApiToken(userId, name, expiresAt) {
      if (name.trim() === '') throw new InvalidInput('give the token a name')
      if (expiresAt !== undefined && (Number.isNaN(Date.parse(expiresAt)) || expired(expiresAt)))
        throw new InvalidInput('expiresAt must be a time in the future')
      const token = newToken()
      const apiToken = await store.createApiToken(hashOf(token), {
        userId,
        name: name.trim(),
        ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
      })
      return { token, apiToken }
    },
    async resolveApiToken(token) {
      const found = await store.apiTokenByHash(hashOf(token))
      if (found === undefined || expired(found.expiresAt)) return undefined
      return active(found.userId)
    },
  }
}

const FREE_FAILURES = 5
const MAX_DELAY_MS = 30_000

// Counted per username, not per IP, so nothing hangs on a header the proxy sets. Never locks
// an account: anyone could lock someone else out (security-and-auth.md).
export interface LoginThrottle {
  wait(key: string): Promise<void>
  failed(key: string): void
  succeeded(key: string): void
}

export function createLoginThrottle(
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): LoginThrottle {
  const failures = new Map<string, number>()
  return {
    async wait(key) {
      const n = failures.get(key) ?? 0
      if (n >= FREE_FAILURES) await sleep(Math.min(1000 * 2 ** (n - FREE_FAILURES), MAX_DELAY_MS))
    },
    failed: (key) => void failures.set(key, (failures.get(key) ?? 0) + 1),
    succeeded: (key) => void failures.delete(key),
  }
}

// One-time, while there is no admin: printed at start and left in dataDir, the way Jenkins
// leaves its initial password, so a container's owner can read it either way (D89).
export interface SetupToken {
  matches(token: string): boolean
  open(): boolean
  close(): void
}

export function createSetupToken(
  dataDir: string,
  needed: boolean,
): SetupToken & { token?: string } {
  const file = join(dataDir, 'setup-token')
  if (!needed) {
    rmSync(file, { force: true })
    return { matches: () => false, open: () => false, close: () => {} }
  }
  let token: string | undefined = newToken()
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  return {
    token,
    matches(given) {
      if (token === undefined) return false
      const [a, b] = [Buffer.from(given), Buffer.from(token)]
      return a.length === b.length && timingSafeEqual(a, b)
    },
    open: () => token !== undefined,
    close() {
      token = undefined
      rmSync(file, { force: true })
    },
  }
}
