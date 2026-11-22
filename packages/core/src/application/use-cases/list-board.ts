import type { Rule } from '../../domain/rule'
import type { Roles, Workflow } from '../../domain/workflow'
import type { Ref, WorkUnit } from '../../domain/work-unit'
import type { StorePort } from '../ports/store'
import type { TrackerPort } from '../ports/tracker'

export interface BoardColumn {
  status: string
  displayName: string
  // Who handles it: engine when a rule watches the column, person when it waits for one.
  handledBy?: 'engine' | 'person'
  // Where a person can send the item from here, the last the main choice.
  outcomes: readonly string[]
  items: WorkUnit[]
}

export interface Board {
  columns: BoardColumn[]
  // Items an agent is working on right now.
  running: Ref[]
  // Of those, the ones a person asked to stop: the agent is winding down.
  stopping: Ref[]
  // Items a Run sent off on failing or giving up, while they are still where it put them.
  // attempts is how many tries it took.
  failed: Record<Ref, { outcome: 'failed' | 'max_attempts'; rule: string; attempts: number }>
  // Per item that has tasks, how many are done.
  tasks: Record<Ref, { done: number; total: number }>
  // An item with this among its labels is on hold.
  holdLabel: string
  // The engine starts no new Run while paused.
  paused: boolean
  roles: Roles
}

// One column per station, in the order the workflow lists them. Tasks come from one more
// list, not one read per item.
export async function listBoard(
  tracker: TrackerPort,
  store: StorePort,
  workflow: Workflow,
  taskStatuses: readonly string[],
  rules: readonly Rule[],
  holdLabel: string,
): Promise<Board> {
  const [items, tasks] = await Promise.all([
    tracker.list(
      'item',
      workflow.statuses.map((s) => s.id),
    ),
    tracker.list('task', taskStatuses),
  ])
  // After the tracker, which takes seconds on Jira: read alongside it, a Run that ended
  // meanwhile shows as Running on a card already in its outcome's column.
  const [live, paused, failedRuns, gaveUp] = await Promise.all([
    store.liveRuns(),
    store.isPaused(),
    store.latestRunsEndedIn('failed'),
    store.latestRunsEndedIn('max_attempts'),
  ])
  const watched = new Set(rules.map((r) => r.watch))
  // A station a person waits on and a rule watches is the engine's (D68).
  const columns = workflow.statuses.map((station) => ({
    status: station.id,
    displayName: station.name,
    ...(watched.has(station.id)
      ? { handledBy: 'engine' as const }
      : station.handledBy !== undefined
        ? { handledBy: station.handledBy }
        : {}),
    outcomes: station.outcomes,
    items: items.filter((i) => i.status === station.id),
  }))
  const counts: Board['tasks'] = {}
  for (const t of tasks) {
    if (t.parent === undefined) continue
    const count = (counts[t.parent] ??= { done: 0, total: 0 })
    count.total++
    if (t.status === 'done') count.done++
  }
  const statusOf = new Map(items.map((i) => [i.ref, i.status]))
  const failed: Board['failed'] = {}
  // A person moving it on, or the next Run, puts it behind them.
  for (const run of [...failedRuns, ...gaveUp])
    if (run.to !== undefined && statusOf.get(run.target) === run.to)
      failed[run.target] = {
        outcome: run.outcome === 'max_attempts' ? 'max_attempts' : 'failed',
        rule: run.rule,
        // The give-up is a Run of its own on top of the attempts that never finished (D38).
        attempts: run.outcome === 'max_attempts' ? run.attempt - 1 : run.attempt,
      }
  return {
    columns,
    running: live.map((r) => r.target),
    failed,
    stopping: live.filter((r) => r.cancelRequestedAt !== undefined).map((r) => r.target),
    tasks: counts,
    holdLabel,
    paused,
    roles: workflow.roles,
  }
}
