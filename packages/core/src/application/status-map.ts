import type { Kind } from '../domain/work-unit'

// Logical status -> the tracker's status key (a name for sqlite, an id for Jira), per kind.
export type StatusMapping = Partial<Record<Kind, Readonly<Record<string, string>>>>

export interface StatusMap {
  toTracker(kind: Kind, status: string): string
  fromTracker(kind: Kind, key: string): string | undefined
  mapped(kind: Kind): string[]
}

export function createStatusMap(mapping: StatusMapping): StatusMap {
  return {
    toTracker(kind, status) {
      const key = mapping[kind]?.[status]
      if (key === undefined) throw new Error(`status "${status}" has no ${kind} mapping in config`)
      return key
    },
    fromTracker(kind, key) {
      return Object.entries(mapping[kind] ?? {}).find(([, k]) => k === key)?.[0]
    },
    mapped(kind) {
      return Object.keys(mapping[kind] ?? {})
    },
  }
}
