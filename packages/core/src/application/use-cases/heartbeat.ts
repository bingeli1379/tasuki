import type { Clock } from '../ports/clock'
import type { Heartbeat, TrackerPort } from '../ports/tracker'

// Another engine on the same tracker project, seen within freshSeconds: a second one would
// claim the same items (D66). A heartbeat of this engine's own, left by a crash, is not one.
export async function otherEngine(
  tracker: TrackerPort,
  clock: Clock,
  self: string,
  freshSeconds: number,
): Promise<Heartbeat | undefined> {
  const beat = await tracker.readHeartbeat?.()
  if (beat === undefined || beat.engineId === self) return undefined
  const age = clock.now().getTime() - Date.parse(beat.lastSeen)
  return age < freshSeconds * 1000 ? beat : undefined
}

export async function beat(tracker: TrackerPort, clock: Clock, self: string): Promise<void> {
  await tracker.writeHeartbeat?.({ engineId: self, lastSeen: clock.now().toISOString() })
}

// On a clean shutdown, so the next engine starts at once. One that took over meanwhile keeps
// its heartbeat.
export async function clearHeartbeat(tracker: TrackerPort, self: string): Promise<void> {
  if ((await tracker.readHeartbeat?.())?.engineId === self)
    await tracker.writeHeartbeat?.(undefined)
}
