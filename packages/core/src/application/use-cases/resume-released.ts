import type { Rule } from '../../domain/rule'
import type { StatusNames } from '../../domain/workflow'
import type { Ref } from '../../domain/work-unit'
import { NotFound } from '../not-found'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'
import { StatusConflict } from '../status-conflict'

export interface ReleasedDeps {
  storage: StoragePort
  runtime: RuntimeStorePort
  named: StatusNames
}

// A Run cancelled by Stop, hold or pausing with every Run stopped leaves the item where it was
// (invariant 6). Once the hold is off, an item left in a claim status goes back to that rule's
// watch status for the next round to pick up (stop-and-recovery.md); one left in a watch
// status needs nothing here. A paused engine claims nothing, so these wait in watch.
// Returns the refs it moved.
export async function resumeReleased(
  { storage, runtime, named }: ReleasedDeps,
  rules: readonly Rule[],
  holdLabel: string,
): Promise<Ref[]> {
  const claims = [...new Set(rules.flatMap((r) => (r.claim === undefined ? [] : [r.claim])))]
  if (claims.length === 0) return []
  // The local store first, as in resumeBlocked: no candidate, no tracker call.
  const candidates = (await runtime.latestRunsEndedIn('cancelled')).filter(
    (r) => r.cancelRequestedBy !== undefined && r.cancelRequestedBy !== 'moved',
  )
  if (candidates.length === 0) return []
  const moved: Ref[] = []
  for (const item of await storage.list('item', claims)) {
    if (item.labels.includes(holdLabel)) continue
    const latest = candidates.find((r) => r.target === item.ref)
    const rule = rules.find((r) => r.id === latest?.rule)
    if (rule?.claim !== item.status) continue
    try {
      await storage.transition(item.ref, rule.claim, rule.watch)
    } catch (e) {
      if (e instanceof StatusConflict || e instanceof NotFound) continue
      throw e
    }
    await storage.addComment({
      target: item.ref,
      author: 'engine',
      kind: 'system',
      body:
        latest?.cancelRequestedBy === 'pause'
          ? `Stopped by pausing the engine. Moved ${named(rule.claim)} → ${named(rule.watch)} for rule \`${rule.id}\` to start again.`
          : `The hold is off. Moved ${named(rule.claim)} → ${named(rule.watch)} for rule \`${rule.id}\` to start again.`,
    })
    moved.push(item.ref)
  }
  return moved
}
