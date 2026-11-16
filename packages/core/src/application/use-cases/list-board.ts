import { ITEM_STATUS_DISPLAY, ITEM_STATUSES } from '../../domain/status'
import type { WorkUnit } from '../../domain/work-unit'
import type { StoragePort } from '../ports/storage'

export interface BoardColumn {
  status: string
  displayName: string
  items: WorkUnit[]
}

// One column per item status the config maps, in board order.
export async function listBoard(
  storage: StoragePort,
  mapped: readonly string[],
): Promise<BoardColumn[]> {
  const statuses = ITEM_STATUSES.filter((s) => mapped.includes(s))
  return Promise.all(
    statuses.map(async (status) => ({
      status,
      displayName: ITEM_STATUS_DISPLAY[status] ?? status,
      items: await storage.list('item', status),
    })),
  )
}
