import type { WorkUnit } from '../../domain/work-unit'
import { taskStatusName as named } from '../../domain/workflow'
import type { StoragePort } from '../ports/storage'
import { StatusConflict } from '../status-conflict'

// Invariant 3: once the item has no live Run, nobody works on its in-progress tasks, so they
// go back to to-do and the next Run picks them up again.
export async function releaseTasks(
  storage: StoragePort,
  tasks: readonly WorkUnit[],
  why: string,
): Promise<void> {
  for (const task of tasks.filter((t) => t.status === 'in-progress')) {
    try {
      await storage.transition(task.ref, 'in-progress', 'to-do')
    } catch (e) {
      // A person moved it meanwhile; theirs wins.
      if (!(e instanceof StatusConflict)) throw e
      continue
    }
    await storage.addComment({
      target: task.ref,
      author: 'engine',
      kind: 'system',
      body: `Moved ${named('in-progress')} → ${named('to-do')}: ${why}.`,
    })
  }
}
