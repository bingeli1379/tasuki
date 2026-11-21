import { exitFor, type Rule } from '../../domain/rule'
import { nextAttempt, type Run } from '../../domain/run'
import { RunConflict } from '../run-conflict'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'
import { StatusConflict } from '../status-conflict'

export interface ClaimDeps {
  storage: StoragePort
  runtime: RuntimeStorePort
}

export interface ClaimLimits {
  maxConcurrentRuns: number
  leaseSeconds: number
  // <dataDir>/workspaces; each item gets its own folder under it.
  workspaceRoot: string
  // Items with this label are left alone (invariant 5).
  holdLabel: string
}

export interface Claimed {
  run: Run
  rule: Rule
}

// One Poller round: every item sitting in a rule's watch status gets a Run, up to the
// concurrency limit. Returns the Runs that now need an agent started.
export async function claimItems(
  { storage, runtime }: ClaimDeps,
  rules: readonly Rule[],
  limits: ClaimLimits,
): Promise<Claimed[]> {
  const live = await runtime.liveRuns()
  const busy = new Set(live.map((r) => r.target))
  let slots = limits.maxConcurrentRuns - live.length
  const claimed: Claimed[] = []
  const waiting = await storage.list(
    'item',
    rules.map((r) => r.watch),
  )
  for (const rule of rules) {
    for (const item of waiting.filter((i) => i.status === rule.watch)) {
      if (slots <= 0) return claimed
      if (busy.has(item.ref) || item.labels.includes(limits.holdLabel)) continue
      const previous = (await runtime.runsFor(item.ref)).find((r) => r.rule === rule.id)
      const attempt = nextAttempt(previous)
      // The Run goes first: a crash before the claim leaves only a lease that expires,
      // with the item still where it was (architecture.md).
      let run: Run
      try {
        run = await runtime.createRun({
          target: item.ref,
          rule: rule.id,
          agent: rule.agent,
          attempt,
          workspace: `${limits.workspaceRoot}/${item.ref}`,
          leaseSeconds: limits.leaseSeconds,
        })
      } catch (e) {
        if (e instanceof RunConflict) continue
        throw e
      }
      busy.add(item.ref)
      if (attempt > rule.maxAttempts) {
        await giveUp(storage, runtime, rule, run)
        continue
      }
      if (rule.claim !== undefined) {
        try {
          await storage.transition(item.ref, rule.watch, rule.claim)
        } catch (e) {
          // Someone moved it since the list: theirs wins.
          if (!(e instanceof StatusConflict)) throw e
          await runtime.finishRun(run.id, 'cancelled')
          continue
        }
      }
      slots--
      claimed.push({ run, rule })
    }
  }
  return claimed
}

// max_attempts is recorded as a Run of its own (D38), so pulling the item back later starts
// it over at 1.
async function giveUp(
  storage: StoragePort,
  runtime: RuntimeStorePort,
  rule: Rule,
  run: Run,
): Promise<void> {
  const to = exitFor(rule, 'max_attempts')
  try {
    if (to !== undefined) await storage.transition(run.target, rule.watch, to)
  } catch (e) {
    if (!(e instanceof StatusConflict)) throw e
    await runtime.finishRun(run.id, 'cancelled')
    return
  }
  await runtime.finishRun(run.id, 'max_attempts')
  await storage.addComment({
    target: run.target,
    author: 'engine',
    kind: 'system',
    body: `Rule ${rule.id} gave up after ${rule.maxAttempts} attempts that never finished. Moved to ${to}.`,
  })
}
