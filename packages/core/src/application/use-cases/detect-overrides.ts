import { runningStatus, type Rule } from '../../domain/rule'
import { NotFound } from '../not-found'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'

export interface OverrideDeps {
  storage: StoragePort
  runtime: RuntimeStorePort
}

// The soft signals (stop-and-recovery.md): a live Run whose item got the hold label, or was
// moved out of the status the Run works in, is asked to wind down. Set in Jira by hand, they
// only show up here. Reads the tracker once per live Run, and not at all with none.
// Returns the ids of the Runs it asked.
export async function detectOverrides(
  { storage, runtime }: OverrideDeps,
  rules: readonly Rule[],
  holdLabel: string,
): Promise<string[]> {
  const asked: string[] = []
  for (const run of await runtime.liveRuns()) {
    if (run.cancelRequestedAt !== undefined) continue
    const rule = rules.find((r) => r.id === run.rule)
    if (rule === undefined) continue
    // Deleted: recovery's business once the lease runs out.
    const item = await storage.get(run.target).catch((e: unknown) => {
      if (e instanceof NotFound) return undefined
      throw e
    })
    if (item === undefined) continue
    const by = item.labels.includes(holdLabel)
      ? 'hold'
      : item.status !== runningStatus(rule)
        ? 'moved'
        : undefined
    if (by === undefined) continue
    await runtime.requestCancel(run.id, 'soft', by)
    asked.push(run.id)
  }
  return asked
}
