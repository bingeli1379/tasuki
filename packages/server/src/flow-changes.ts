import { defaultStationName, TASK_STATUS_DISPLAY, TASK_STATUSES } from '@tasuki/core'

// One thing a save changed, as the history on the settings page lists it (W4b, D94).
export interface SettingChange {
  text: string
  // Set for long text, shown side by side on request: a rule's prompt, '' for none.
  before?: string
  after?: string
}

type Raw = Record<string, unknown>

const obj = (value: unknown): Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {}
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.map(obj) : [])
const words = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])
const byId = (items: Raw[]): Map<string, Raw> => new Map(items.map((i) => [String(i['id']), i]))

// What a saved flow holds where text goes is a string or a number.
const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : ''

function shown(value: unknown, none = 'none'): string {
  if (value === undefined || value === null || value === '') return none
  if (Array.isArray(value)) return value.length === 0 ? none : value.join(', ')
  return text(value)
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

// Both as saved: valid flows, with what is left at its default left out (config-and-rules.md).
export function describeChanges(before: unknown, after: unknown): SettingChange[] {
  const changes: SettingChange[] = []
  const add = (text: string): void => {
    changes.push({ text })
  }
  const field = (what: string, from: unknown, to: unknown, none?: string): void => {
    if (!same(from, to)) add(`${what}: ${shown(from, none)} → ${shown(to, none)}`)
  }

  const was = obj(obj(before)['workflow'])
  const now = obj(obj(after)['workflow'])
  const oldStations = byId(list(was['statuses']))
  const newStations = byId(list(now['statuses']))
  const name = (s: Raw): string =>
    typeof s['name'] === 'string' ? s['name'] : defaultStationName(text(s['id']))

  for (const [id, s] of oldStations)
    if (!newStations.has(id)) add(`Removed the status ${name(s)} (${id})`)
  for (const [id, s] of newStations) {
    const old = oldStations.get(id)
    if (old === undefined) {
      add(`Added the status ${name(s)} (${id})`)
      continue
    }
    const what = `Status ${id}`
    field(`${what} name`, name(old), name(s))
    field(`${what} tracker status`, old['key'], s['key'])
    if (old['handledBy'] !== s['handledBy'])
      add(
        s['handledBy'] === 'person'
          ? `${what} now waits for a person`
          : `${what} no longer waits for a person`,
      )
    field(`${what} buttons`, words(old['outcomes']), words(s['outcomes']))
  }
  const kept = (ids: Iterable<string>, other: Map<string, Raw>): string[] =>
    [...ids].filter((id) => other.has(id))
  if (!same(kept(oldStations.keys(), newStations), kept(newStations.keys(), oldStations)))
    add(`New status order: ${[...newStations.keys()].join(', ')}`)

  const oldRoles = obj(was['roles'])
  const newRoles = obj(now['roles'])
  field('New items start in', oldRoles['entry'], newRoles['entry'])
  field('When an agent fails, the item goes to', oldRoles['failure'], newRoles['failure'])

  const oldTasks = obj(was['taskStatuses'])
  const newTasks = obj(now['taskStatuses'])
  for (const status of TASK_STATUSES)
    field(
      `Task status ${TASK_STATUS_DISPLAY[status] ?? status} tracker status`,
      oldTasks[status],
      newTasks[status],
      'not used',
    )

  const oldRules = byId(list(obj(before)['rules']))
  const newRules = byId(list(obj(after)['rules']))
  for (const id of oldRules.keys()) if (!newRules.has(id)) add(`Removed the rule ${id}`)
  for (const [id, r] of newRules) {
    const old = oldRules.get(id)
    if (old === undefined) {
      add(`Added the rule ${id}`)
      continue
    }
    const what = `Rule ${id}`
    field(`${what} watches`, old['watch'], r['watch'])
    field(`${what} while working`, old['claim'], r['claim'], 'leave it where it is')
    field(`${what} agent`, old['agent'], r['agent'])
    const onOff = (v: unknown): string => (v === true ? 'on' : 'off')
    field(`${what} dispatch`, onOff(old['dispatch']), onOff(r['dispatch']))
    field(`${what} needs feedback`, onOff(old['needsFeedback']), onOff(r['needsFeedback']))
    field(`${what} attempts`, old['maxAttempts'], r['maxAttempts'], 'default')
    field(`${what} session`, old['session'], r['session'], 'fresh')
    const oldOut = obj(old['outcomes'])
    const newOut = obj(r['outcomes'])
    for (const outcome of new Set([...Object.keys(oldOut), ...Object.keys(newOut)]))
      field(`${what} ${outcome} goes to`, oldOut[outcome], newOut[outcome], 'default')
    const oldPrompt = text(old['prompt'])
    const newPrompt = text(r['prompt'])
    if (oldPrompt !== newPrompt)
      changes.push({ text: `${what} prompt changed`, before: oldPrompt, after: newPrompt })
  }

  field('Hold label', obj(obj(before)['labels'])['hold'], obj(obj(after)['labels'])['hold'])
  return changes
}
