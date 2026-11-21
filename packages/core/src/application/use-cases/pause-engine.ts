import type { RuntimeStorePort } from '../ports/runtime-store'

// The global pause (stop-and-recovery.md): no new Run starts until resumed. With kill, every
// live Run is also stopped hard; its item stays where it is and carries on once resumed.
// Returns the ids of the Runs it stopped.
export async function pauseEngine(runtime: RuntimeStorePort, kill: boolean): Promise<string[]> {
  await runtime.setPaused(true)
  if (!kill) return []
  const live = await runtime.liveRuns()
  for (const run of live) await runtime.requestCancel(run.id, 'hard', 'pause')
  return live.map((r) => r.id)
}

export async function resumeEngine(runtime: RuntimeStorePort): Promise<void> {
  await runtime.setPaused(false)
}
