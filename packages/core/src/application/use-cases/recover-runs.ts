import type { Rule } from '../../domain/rule'
import type { StatusNames } from '../../domain/workflow'
import type { Clock } from '../ports/clock'
import type { StorePort } from '../ports/store'
import type { TrackerPort } from '../ports/tracker'
import { NotFound } from '../not-found'
import { StatusConflict } from '../status-conflict'
import { recoverTaskRun } from './dispatch'
import { releaseTasks } from './release-tasks'

export interface RecoverDeps {
  tracker: TrackerPort
  store: StorePort
  clock: Clock
  named: StatusNames
}

// Runs whose lease ran out are abandoned. An item left in the claim status goes back to the
// watch status, where the next round picks it up as the next attempt (stop-and-recovery.md).
// Returns the ids of the Runs it abandoned.
export async function recoverRuns(
  { tracker, store, clock, named }: RecoverDeps,
  rules: readonly Rule[],
): Promise<string[]> {
  const now = clock.now().getTime()
  const expired = (await store.liveRuns()).filter((r) => Date.parse(r.leaseUntil) < now)
  for (const run of expired) {
    const rule = rules.find((r) => r.id === run.rule)
    if (run.target !== run.item) {
      await recoverTaskRun({ tracker, store }, rule, run)
      continue
    }
    // Deleted from the tracker while its Run was alive: nothing is left to send back, and
    // letting NotFound out would stop every round from here on.
    const item = await tracker.get(run.target).catch((e: unknown) => {
      if (e instanceof NotFound) return undefined
      throw e
    })
    if (item === undefined) {
      await store.finishRun(run.id, 'abandoned')
      continue
    }
    // Without a claim status the item never left watch, unless a person moved it.
    const retried = rule !== undefined && rule.claim === undefined && item.status === rule.watch
    // Sent back first, for the same reason finishRun moves first.
    let back = false
    if (rule?.claim !== undefined) {
      try {
        await tracker.transition(run.target, rule.claim, rule.watch)
        back = true
      } catch (e) {
        // Already somewhere else: a person moved it, or this ran before and crashed.
        if (!(e instanceof StatusConflict)) throw e
      }
    }
    await store.finishRun(run.id, 'abandoned')
    if (rule !== undefined && (back || retried))
      await tracker.addComment({
        target: run.target,
        author: 'engine',
        kind: 'system',
        body: back
          ? `Rule \`${rule.id}\`, attempt ${run.attempt}: the agent stopped answering. Moved ${named(rule.claim ?? rule.watch)} → ${named(rule.watch)} to try again.`
          : `Rule \`${rule.id}\`, attempt ${run.attempt}: the agent stopped answering. The next round tries again.`,
      })
    await releaseTasks(tracker, await tracker.children(run.target), 'the agent stopped answering')
  }
  return expired.map((r) => r.id)
}
