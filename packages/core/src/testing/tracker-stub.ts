import type { TrackerPort } from '../application/ports/tracker'

// Test double: only the methods a test passes exist; calling any other one fails the test.
export function trackerStub(methods: Partial<TrackerPort>): TrackerPort {
  return new Proxy(methods as TrackerPort, {
    get: (target, key: string) =>
      key in target
        ? target[key as keyof TrackerPort]
        : () => Promise.reject(new Error(`tracker.${key} was not expected`)),
  })
}
