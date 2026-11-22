import type { Rule } from '@tasuki/core'
import { randomBytes } from 'node:crypto'

// One token per Run, held in memory only: a restart abandons every Run anyway, and its
// token must not outlive it (security-and-auth.md). It carries the rule the Run started
// under, which a save of the flow does not change for it (D91).
export interface RunTokens {
  issue(runId: string, rule: Rule): string
  resolve(token: string): { runId: string; rule: Rule } | undefined
  revoke(runId: string): void
}

export function createRunTokens(): RunTokens {
  const runs = new Map<string, { runId: string; rule: Rule }>()
  return {
    issue(runId, rule) {
      const token = randomBytes(32).toString('base64url')
      runs.set(token, { runId, rule })
      return token
    },
    resolve: (token) => runs.get(token),
    revoke(runId) {
      for (const [token, held] of runs) if (held.runId === runId) runs.delete(token)
    },
  }
}
