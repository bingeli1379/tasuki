import { exitFor, type Rule } from '../../domain/rule'
import { nextAttempt, type Run } from '../../domain/run'
import type { StatusNames } from '../../domain/workflow'
import { RunConflict } from '../run-conflict'
import type { StorePort } from '../ports/store'
import type { TrackerPort } from '../ports/tracker'
import { StatusConflict } from '../status-conflict'
import { claimTasks } from './dispatch'

export interface ClaimDeps {
  tracker: TrackerPort
  store: StorePort
  named: StatusNames
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
  { tracker, store, named }: ClaimDeps,
  rules: readonly Rule[],
  limits: ClaimLimits,
): Promise<Claimed[]> {
  const live = await store.liveRuns()
  const busy = new Set(live.map((r) => r.target))
  // An item whose tasks are running is not claimed by another rule (invariant 1).
  const busyItems = new Set(live.map((r) => r.item))
  let slots = limits.maxConcurrentRuns - live.length
  const claimed: Claimed[] = []
  const waiting = await tracker.list(
    'item',
    rules.map((r) => r.watch),
  )
  for (const rule of rules) {
    for (const item of waiting.filter((i) => i.status === rule.watch)) {
      if (slots <= 0) return claimed
      if (rule.dispatch) {
        if (busy.has(item.ref) || item.labels.includes(limits.holdLabel)) continue
        const runs = await claimTasks({ tracker, store }, rule, item, busy, slots, limits)
        for (const run of runs) busy.add(run.target)
        slots -= runs.length
        claimed.push(...runs.map((run) => ({ run, rule })))
        continue
      }
      if (busyItems.has(item.ref) || item.labels.includes(limits.holdLabel)) continue
      const runs = await store.runsFor(item.ref)
      if (rule.needsFeedback && !(await hasFeedback(tracker, item.ref, runs[0]))) {
        await askForFeedback(tracker, named, rule, item.ref)
        continue
      }
      const previous = runs.find((r) => r.rule === rule.id)
      const attempt = nextAttempt(previous)
      // The Run goes first: a crash before the claim leaves only a lease that expires,
      // with the item still where it was (architecture.md).
      let run: Run
      try {
        run = await store.createRun({
          target: item.ref,
          item: item.ref,
          rule: rule.id,
          agent: rule.agent,
          attempt,
          from: rule.watch,
          workspace: `${limits.workspaceRoot}/${item.ref}`,
          leaseSeconds: limits.leaseSeconds,
        })
      } catch (e) {
        if (e instanceof RunConflict) continue
        throw e
      }
      busy.add(item.ref)
      busyItems.add(item.ref)
      if (attempt > rule.maxAttempts) {
        await giveUp(tracker, store, named, rule, run)
        continue
      }
      if (rule.claim !== undefined) {
        try {
          await tracker.transition(item.ref, rule.watch, rule.claim)
        } catch (e) {
          // Someone moved it since the list: theirs wins.
          if (!(e instanceof StatusConflict)) throw e
          await store.finishRun(run.id, 'cancelled')
          continue
        }
      }
      slots--
      claimed.push({ run, rule })
    }
  }
  return claimed
}

// A reworking agent goes by what a person wrote since the last Run on the item ended. The
// board and the user MCP ask for it, but an item moved here in Jira by hand may have none
// (D75). The two clocks are the engine's and the tracker's; they are close enough for this.
async function hasFeedback(
  tracker: TrackerPort,
  ref: string,
  last: Run | undefined,
): Promise<boolean> {
  const since = last?.finishedAt === undefined ? 0 : Date.parse(last.finishedAt)
  return (await tracker.comments(ref)).some(
    (c) => c.author === 'human' && c.kind === 'note' && Date.parse(c.createdAt) > since,
  )
}

// Without feedback there is nothing to rework from: no agent starts, and the item takes the
// rule's needs_input exit, as a reworking agent asking for it would.
async function askForFeedback(
  tracker: TrackerPort,
  named: StatusNames,
  rule: Rule,
  ref: string,
): Promise<void> {
  const to = exitFor(rule, 'needs_input')
  if (to === undefined) throw new Error(`rule ${rule.id} has no exit on needs_input`)
  try {
    await tracker.transition(ref, rule.watch, to)
  } catch (e) {
    if (!(e instanceof StatusConflict)) throw e
    return
  }
  await tracker.addComment({
    target: ref,
    author: 'engine',
    kind: 'system',
    body: `Rule \`${rule.id}\` needs a comment saying what to rework, and none was left since the last run. Moved ${named(rule.watch)} → ${named(to)}: write one, then move it back to ${named(rule.watch)}.`,
  })
}

// max_attempts is recorded as a Run of its own (D38), so pulling the item back later starts
// it over at 1.
async function giveUp(
  tracker: TrackerPort,
  store: StorePort,
  named: StatusNames,
  rule: Rule,
  run: Run,
): Promise<void> {
  const to = exitFor(rule, 'max_attempts')
  try {
    if (to !== undefined) await tracker.transition(run.target, rule.watch, to)
  } catch (e) {
    if (!(e instanceof StatusConflict)) throw e
    await store.finishRun(run.id, 'cancelled')
    return
  }
  await store.finishRun(run.id, 'max_attempts', to)
  await tracker.addComment({
    target: run.target,
    author: 'engine',
    kind: 'system',
    body: `Rule \`${rule.id}\` gave up after ${rule.maxAttempts} attempts that never finished. ${to === undefined ? 'Left where it is.' : `Moved ${named(rule.watch)} → ${named(to)}.`}`,
  })
}
