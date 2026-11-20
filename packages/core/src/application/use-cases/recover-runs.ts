import type { Rule } from '../../domain/rule'
import type { Clock } from '../ports/clock'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'
import { NotFound } from '../not-found'
import { StatusConflict } from '../status-conflict'
import { releaseTasks } from './release-tasks'

export interface RecoverDeps {
  storage: StoragePort
  runtime: RuntimeStorePort
  clock: Clock
}

// Runs whose lease ran out are abandoned. An item left in the claim status goes back to the
// watch status, where the next round picks it up as the next attempt (stop-and-recovery.md).
// Returns the ids of the Runs it abandoned.
export async function recoverRuns(
  { storage, runtime, clock }: RecoverDeps,
  rules: readonly Rule[],
): Promise<string[]> {
  const now = clock.now().getTime()
  const expired = (await runtime.liveRuns()).filter((r) => Date.parse(r.leaseUntil) < now)
  for (const run of expired) {
    const rule = rules.find((r) => r.id === run.rule)
    // Deleted from the tracker while its Run was alive: nothing is left to send back, and
    // letting NotFound out would stop every round from here on.
    const item = await storage.get(run.target).catch((e: unknown) => {
      if (e instanceof NotFound) return undefined
      throw e
    })
    if (item === undefined) {
      await runtime.finishRun(run.id, 'abandoned')
      continue
    }
    // Without a claim status the item never left watch, unless a person moved it.
    const retried = rule !== undefined && rule.claim === undefined && item.status === rule.watch
    // Sent back first, for the same reason finishRun moves first.
    let back = false
    if (rule?.claim !== undefined) {
      try {
        await storage.transition(run.target, rule.claim, rule.watch)
        back = true
      } catch (e) {
        // Already somewhere else: a person moved it, or this ran before and crashed.
        if (!(e instanceof StatusConflict)) throw e
      }
    }
    await runtime.finishRun(run.id, 'abandoned')
    if (rule !== undefined && (back || retried))
      await storage.addComment({
        target: run.target,
        author: 'engine',
        kind: 'system',
        body: back
          ? `Rule ${rule.id}, attempt ${run.attempt}: the agent stopped answering. Moved back to ${rule.watch} to try again.`
          : `Rule ${rule.id}, attempt ${run.attempt}: the agent stopped answering. The next round tries again.`,
      })
    await releaseTasks(storage, await storage.children(run.target), 'the agent stopped answering')
  }
  return expired.map((r) => r.id)
}
