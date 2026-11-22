import type { StorePort } from '../ports/store'

// The global pause (stop-and-recovery.md): no new Run starts until resumed. With kill, every
// live Run is also stopped hard; its item stays where it is and carries on once resumed.
// Returns the ids of the Runs it stopped.
export async function pauseEngine(store: StorePort, kill: boolean): Promise<string[]> {
  await store.setPaused(true)
  if (!kill) return []
  const live = await store.liveRuns()
  for (const run of live) await store.requestCancel(run.id, 'hard', 'pause')
  return live.map((r) => r.id)
}

export async function resumeEngine(store: StorePort): Promise<void> {
  await store.setPaused(false)
}
