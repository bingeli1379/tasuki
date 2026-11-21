import { exitFor, type Rule } from '../../domain/rule'
import type { StatusNames } from '../../domain/workflow'
import type { Ref } from '../../domain/work-unit'
import { NotFound } from '../not-found'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'
import { StatusConflict } from '../status-conflict'

export interface ResumeDeps {
  storage: StoragePort
  runtime: RuntimeStorePort
  named: StatusNames
}

// Auto-resume (state-machine.md): an item whose last Run stopped at manual tasks goes back to
// that rule's watch status once no task of it is manual any more, unless it is on hold.
// "The manual tasks that blocked it" is read as every manual task now: the runtime store does
// not record which ones did, and one a person added meanwhile is one more to wait for (D71).
// Returns the refs it moved.
export async function resumeBlocked(
  { storage, runtime, named }: ResumeDeps,
  rules: readonly Rule[],
  holdLabel: string,
): Promise<Ref[]> {
  const parked = [...new Set(rules.flatMap((r) => exitFor(r, 'blocked_manual') ?? []))]
  if (parked.length === 0) return []
  // The local store first: with no candidate, this round costs the tracker nothing (Jira
  // rate-limits per call, D64).
  const candidates = await runtime.latestRunsEndedIn('blocked_manual')
  if (candidates.length === 0) return []
  const resumed: Ref[] = []
  for (const item of await storage.list('item', parked)) {
    if (item.labels.includes(holdLabel)) continue
    const latest = candidates.find((r) => r.target === item.ref)
    if (latest === undefined) continue
    const rule = rules.find((r) => r.id === latest.rule)
    if (rule === undefined || exitFor(rule, 'blocked_manual') !== item.status) continue
    try {
      if ((await storage.children(item.ref)).some((t) => t.status === 'manual')) continue
      await storage.transition(item.ref, item.status, rule.watch)
    } catch (e) {
      // Moved or deleted by a person since the list: theirs wins, and one item must not stop
      // the round.
      if (e instanceof StatusConflict || e instanceof NotFound) continue
      throw e
    }
    await storage.addComment({
      target: item.ref,
      author: 'engine',
      kind: 'system',
      body: `No task is manual any more. Moved ${named(item.status)} → ${named(rule.watch)} for rule \`${rule.id}\` to carry on.`,
    })
    resumed.push(item.ref)
  }
  return resumed
}
