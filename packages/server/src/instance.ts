import {
  assertEditsInstance,
  InvalidInput,
  saveInstance,
  type Account,
  type StorePort,
} from '@tasuki/core'

export interface Limits {
  maxConcurrentRuns: number
  leaseSeconds: number
  defaultMaxAttempts: number
  // A soft cancel turns hard after this long; a hard one sends SIGKILL after this long.
  softGraceSeconds: number
  hardGraceSeconds: number
}

// What the instance runs on, kept in the store and edited by an admin on the General page
// (D105). Read again every poll round, so a save needs no restart.
export interface Instance {
  pollSeconds: number
  limits: Limits
}

// What the defaults depend on from the file.
export interface InstanceContext {
  pollSeconds: number
}

// Jira searches are slower and rate limited, so it is polled less often.
export const pollDefaultFor = (trackerPlugin: string): InstanceContext => ({
  pollSeconds: trackerPlugin === '@tasuki/jira-cloud' ? 30 : 5,
})

type Raw = Record<string, unknown>

const LIMIT_DEFAULTS: Limits = {
  maxConcurrentRuns: 2,
  leaseSeconds: 120,
  defaultMaxAttempts: 3,
  softGraceSeconds: 300,
  hardGraceSeconds: 10,
}

const FIELDS = ['poll', 'limits']

const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(message: string): never {
  throw new InvalidInput(message)
}

function positive(raw: Raw, key: string, fallback: number, path: string): number {
  const value = raw[key] ?? fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    fail(`${path}.${key} must be a whole number of at least 1`)
  return value as number
}

// Throws InvalidInput naming the field at fault. Anything left out takes its default.
export function parseInstance(raw: unknown, ctx: InstanceContext): Instance {
  if (!isObject(raw)) return fail('the instance settings must be an object')
  for (const key of Object.keys(raw))
    if (!FIELDS.includes(key)) fail(`${key}: not an instance setting (${FIELDS.join(', ')})`)
  const poll = raw['poll'] ?? {}
  if (!isObject(poll)) return fail('poll must be an object')
  const limits = raw['limits'] ?? {}
  if (!isObject(limits)) return fail('limits must be an object')
  for (const key of Object.keys(limits))
    if (!(key in LIMIT_DEFAULTS)) fail(`limits.${key}: not a limit`)
  return {
    pollSeconds: positive(poll, 'intervalSeconds', ctx.pollSeconds, 'poll'),
    limits: Object.fromEntries(
      Object.entries(LIMIT_DEFAULTS).map(([key, fallback]) => [
        key,
        positive(limits, key, fallback, 'limits'),
      ]),
    ) as unknown as Limits,
  }
}

// The instance settings in use, swapped whole on a save.
export interface LiveInstance {
  current(): Instance
  // What the General page edits: the settings as saved, or nothing before any save.
  saved(): { version?: number; value: unknown }
  save(store: StorePort, actor: Account, expected: number | undefined, raw: unknown): Promise<void>
  // Reads the saved settings again against new defaults: the tracker was swapped.
  rebase(ctx: InstanceContext): void
}

export function createLiveInstance(
  ctx: InstanceContext,
  latest?: { version: number; value: unknown },
): LiveInstance {
  let context = ctx
  let saved: { version?: number; value: unknown } = latest ?? { value: {} }
  let current = parseInstance(saved.value, context)
  return {
    current: () => current,
    saved: () => saved,
    rebase(next) {
      context = next
      current = parseInstance(saved.value, context)
    },
    async save(store, actor, expected, raw) {
      // Who may comes before what is wrong with it, as for the flow.
      assertEditsInstance(actor)
      const next = parseInstance(raw, context)
      const version = await saveInstance(store, 'instance', actor, expected, raw)
      current = next
      saved = { version: version.version, value: raw }
    },
  }
}

// The instance settings as last saved, or the defaults.
export async function loadInstance(store: StorePort, ctx: InstanceContext): Promise<LiveInstance> {
  const latest = await store.latestSettings('instance')
  try {
    return createLiveInstance(ctx, latest)
  } catch (e) {
    throw new Error(
      `the instance settings saved in the store do not fit: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}
