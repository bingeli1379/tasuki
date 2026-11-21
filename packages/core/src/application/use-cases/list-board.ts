import type { Rule } from '../../domain/rule'
import { AWAITING_PERSON, ITEM_STATUS_DISPLAY, ITEM_STATUSES } from '../../domain/status'
import type { Ref, WorkUnit } from '../../domain/work-unit'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'

export interface BoardColumn {
  status: string
  displayName: string
  // Whose move it is: engine when a rule watches the column, person when it waits for one.
  turn?: 'engine' | 'person'
  items: WorkUnit[]
}

export interface Board {
  columns: BoardColumn[]
  // Items an agent is working on right now.
  running: Ref[]
  // Per item that has tasks, how many are done.
  tasks: Record<Ref, { done: number; total: number }>
}

// One column per item status the config maps, in board order. Tasks come from one more
// list, not one read per item.
export async function listBoard(
  storage: StoragePort,
  runtime: RuntimeStorePort,
  mapped: { item: readonly string[]; task: readonly string[] },
  rules: readonly Rule[],
): Promise<Board> {
  const statuses = ITEM_STATUSES.filter((s) => mapped.item.includes(s))
  const [items, tasks] = await Promise.all([
    storage.list('item', statuses),
    storage.list('task', mapped.task),
  ])
  // After the tracker, which takes seconds on Jira: read alongside it, a Run that ended
  // meanwhile shows as Running on a card already in its outcome's column.
  const live = await runtime.liveRuns()
  const watched = new Set(rules.map((r) => r.watch))
  const columns = statuses.map((status) => ({
    status,
    displayName: ITEM_STATUS_DISPLAY[status] ?? status,
    ...(watched.has(status)
      ? { turn: 'engine' as const }
      : AWAITING_PERSON.includes(status)
        ? { turn: 'person' as const }
        : {}),
    items: items.filter((i) => i.status === status),
  }))
  const counts: Board['tasks'] = {}
  for (const t of tasks) {
    if (t.parent === undefined) continue
    const count = (counts[t.parent] ??= { done: 0, total: 0 })
    count.total++
    if (t.status === 'done') count.done++
  }
  return { columns, running: live.map((r) => r.target), tasks: counts }
}
