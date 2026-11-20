import { ITEM_STATUS_DISPLAY, ITEM_STATUSES } from '../../domain/status'
import type { Ref, WorkUnit } from '../../domain/work-unit'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'

export interface BoardColumn {
  status: string
  displayName: string
  items: WorkUnit[]
}

export interface Board {
  columns: BoardColumn[]
  // Items an agent is working on right now.
  running: Ref[]
}

// One column per item status the config maps, in board order.
export async function listBoard(
  storage: StoragePort,
  runtime: RuntimeStorePort,
  mapped: readonly string[],
): Promise<Board> {
  const statuses = ITEM_STATUSES.filter((s) => mapped.includes(s))
  const [items, live] = await Promise.all([storage.list('item', statuses), runtime.liveRuns()])
  const columns = statuses.map((status) => ({
    status,
    displayName: ITEM_STATUS_DISPLAY[status] ?? status,
    items: items.filter((i) => i.status === status),
  }))
  return { columns, running: live.map((r) => r.target) }
}
