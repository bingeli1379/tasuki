import { randomBytes } from 'node:crypto'

// One token per Run, held in memory only: a restart abandons every Run anyway, and its
// token must not outlive it (security-and-auth.md).
export interface RunTokens {
  issue(runId: string): string
  resolve(token: string): string | undefined
  revoke(runId: string): void
}

export function createRunTokens(): RunTokens {
  const runs = new Map<string, string>()
  return {
    issue(runId) {
      const token = randomBytes(32).toString('base64url')
      runs.set(token, runId)
      return token
    },
    resolve: (token) => runs.get(token),
    revoke(runId) {
      for (const [token, id] of runs) if (id === runId) runs.delete(token)
    },
  }
}
