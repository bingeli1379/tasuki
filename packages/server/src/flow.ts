import {
  assertEditsFlow,
  createStatusMap,
  DEFAULT_WORKFLOW,
  defaultStationName,
  ENGINE_OUTCOMES,
  InvalidInput,
  MODE_OUTCOMES,
  saveFlow,
  TASK_STATUSES,
  type Account,
  type FlowVersion,
  type Roles,
  type Rule,
  type RuleMode,
  type RuleSession,
  type Station,
  type StatusMap,
  type StatusMapping,
  type StorePort,
  type TrackerPort,
  type Workflow,
} from '@tasuki/core'
import { defaultPrompt } from './prompts'

// The part of the settings kept in the store and edited on the settings page (D91).
export interface Flow {
  workflow: Workflow
  // What the tracker plugin is handed: each station's and task status's tracker key.
  statuses: StatusMapping
  rules: Rule[]
  // The label that keeps the engine off an item.
  holdLabel: string
}

// What a flow is checked against from the file: rules name its agents.
export interface FlowContext {
  agents: readonly string[]
  defaultMaxAttempts: number
}

type Raw = Record<string, unknown>

const MODES = Object.keys(MODE_OUTCOMES) as RuleMode[]
const SESSIONS: readonly RuleSession[] = ['fresh', 'per-item']
const ROLES: readonly (keyof Roles)[] = ['entry', 'failure']
// sqlite keys a status by its logical name, so renaming one moves no data (D91).
const TASK_KEYS = Object.fromEntries(TASK_STATUSES.map((s) => [s, s]))

const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(message: string): never {
  throw new InvalidInput(message)
}

// What a store that was never saved to runs on: the default stations, keyed for sqlite, and
// no rules. splitting is left out, since only a rule's claim ever fills it (D74).
export const DEFAULT_FLOW: Readonly<Record<string, unknown>> = {
  workflow: {
    statuses: DEFAULT_WORKFLOW.statuses
      .filter((s) => s.id !== 'splitting')
      .map(({ id, name, handledBy, outcomes }) => ({
        id,
        name,
        ...(handledBy === undefined ? {} : { handledBy }),
        outcomes: [...outcomes],
      })),
    roles: { ...DEFAULT_WORKFLOW.roles },
    taskStatuses: TASK_KEYS,
  },
  rules: [],
  labels: { hold: 'hold' },
}

// The stations, their roles and the tracker keys of them and of the task statuses
// (config-and-rules.md). Rules are checked against it after.
function parseWorkflow(value: unknown): { workflow: Workflow; statuses: StatusMapping } {
  if (!isObject(value)) return fail('workflow is required')
  const list = value['statuses']
  if (!Array.isArray(list) || list.length === 0)
    return fail('workflow.statuses must list at least one status')
  const keys: Record<string, string> = {}
  const stations = list.map((raw: unknown, index): Station => {
    const path = `workflow.statuses[${index}]`
    if (!isObject(raw)) return fail(`${path} must be an object`)
    const id = raw['id']
    // Logical names are kebab-case (CLAUDE.md); display names come from name.
    if (typeof id !== 'string' || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id))
      return fail(`${path}.id must be a kebab-case name such as ai-review`)
    if (keys[id] !== undefined) fail(`workflow.statuses: ${id} is listed twice`)
    const name = raw['name'] ?? defaultStationName(id)
    if (typeof name !== 'string' || name === '') fail(`${path} (${id}).name must be text`)
    const key = raw['key'] ?? id
    if (typeof key !== 'string' || key === '')
      return fail(`${path} (${id}).key must be the tracker's status`)
    keys[id] = key
    const handledBy = raw['handledBy']
    if (handledBy !== undefined && handledBy !== 'person')
      fail(`${path} (${id}).handledBy can only be person; a rule watching it makes it the engine's`)
    const outcomes: unknown = raw['outcomes'] ?? []
    if (!Array.isArray(outcomes) || outcomes.some((to) => typeof to !== 'string'))
      return fail(`${path} (${id}).outcomes must list statuses`)
    if (new Set(outcomes).size !== outcomes.length)
      fail(`${path} (${id}).outcomes lists a status twice`)
    return {
      id,
      name: name as string,
      ...(handledBy === undefined ? {} : { handledBy: 'person' as const }),
      outcomes: outcomes as string[],
    }
  })
  const owners = Object.entries(keys).filter(([, k], i, all) =>
    all.some(([, other], j) => j !== i && other === k),
  )
  if (owners.length > 0)
    fail(
      `workflow.statuses: ${owners.map(([id]) => id).join(' and ')} share the tracker key ${owners[0]?.[1]}`,
    )
  for (const station of stations)
    for (const to of station.outcomes) {
      if (keys[to] === undefined)
        fail(
          `workflow.statuses (${station.id}).outcomes: status "${to}" is not in workflow.statuses`,
        )
      if (to === station.id)
        fail(`workflow.statuses (${station.id}).outcomes: ${to} must be another status`)
    }

  const rawRoles = value['roles']
  if (!isObject(rawRoles)) return fail('workflow.roles is required')
  for (const role of Object.keys(rawRoles))
    if (!ROLES.includes(role as keyof Roles))
      fail(`workflow.roles.${role}: not a role (${ROLES.join(', ')})`)
  for (const role of ROLES)
    if (rawRoles[role] === undefined) fail(`workflow.roles.${role} is required`)
  for (const [role, id] of Object.entries(rawRoles))
    if (typeof id !== 'string' || keys[id] === undefined)
      fail(`workflow.roles.${role}: status "${String(id)}" is not in workflow.statuses`)

  const tasks = value['taskStatuses'] ?? TASK_KEYS
  if (!isObject(tasks)) return fail('workflow.taskStatuses must be an object')
  const unknown = Object.keys(tasks).filter((s) => !TASK_STATUSES.includes(s))
  if (unknown.length > 0) fail(`workflow.taskStatuses: unknown status ${unknown.join(', ')}`)
  for (const [status, key] of Object.entries(tasks))
    if (typeof key !== 'string' || key === '')
      fail(`workflow.taskStatuses.${status} must be the tracker's status`)
  return {
    workflow: { statuses: stations, roles: rawRoles as unknown as Roles },
    statuses: { item: keys, task: tasks as Record<string, string> },
  }
}

function positive(raw: Raw, key: string, fallback: number, path: string): number {
  const value = raw[key] ?? fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    fail(`${path}.${key} must be a whole number of at least 1`)
  return value as number
}

// The checks doctor also runs on rules (config-and-rules.md, 1 to 5).
function parseRules(
  value: unknown,
  mapped: readonly string[],
  ctx: FlowContext,
  failure: string,
): Rule[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return fail('rules must be a list')
  const rules = value.map((raw: unknown, index): Rule => {
    if (!isObject(raw)) return fail(`rules[${index}] must be an object`)
    const path = `rules[${index}]${typeof raw['id'] === 'string' ? ` (${raw['id']})` : ''}`
    const text = (key: string): string => {
      const v = raw[key]
      if (typeof v !== 'string' || v === '') return fail(`${path}.${key} is required`)
      return v
    }
    const status = (key: string, v: string): string => {
      if (!mapped.includes(v)) fail(`${path}.${key}: status "${v}" is not in workflow.statuses`)
      return v
    }
    const id = text('id')
    const watch = status('watch', text('watch'))
    const claim = raw['claim'] === undefined ? undefined : status('claim', text('claim'))
    if (claim === watch) fail(`${path}.claim must differ from watch`)
    const agent = text('agent')
    if (!ctx.agents.includes(agent))
      fail(`${path}.agent: no agent "${agent}" in the config file's agents`)
    const mode = text('mode') as RuleMode
    if (!MODES.includes(mode)) fail(`${path}.mode must be one of ${MODES.join(', ')}`)
    const rawOutcomes = raw['outcomes'] ?? {}
    if (!isObject(rawOutcomes)) return fail(`${path}.outcomes must be an object`)
    const outcomes: Rule['outcomes'] = {}
    for (const [name, target] of Object.entries(rawOutcomes)) {
      // The agent reports these names, so they read like the built-in ones.
      if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name))
        fail(`${path}.outcomes.${name}: a name such as needs_design`)
      if (name === 'cancelled' || name === 'abandoned')
        fail(`${path}.outcomes.${name}: the item does not move on it`)
      if (typeof target !== 'string') return fail(`${path}.outcomes.${name} must be a status`)
      outcomes[name] = status(`outcomes.${name}`, target)
    }
    for (const name of MODE_OUTCOMES[mode])
      if (outcomes[name] === undefined) fail(`${path}.outcomes.${name} is required in ${mode} mode`)
    // The item never leaves watch while its tasks run, and only the engine picks its exit,
    // from the tasks (D102).
    if (mode === 'dispatch') {
      if (claim !== undefined) fail(`${path}.claim: a dispatch rule keeps the item in watch`)
      const own = Object.keys(outcomes).find(
        (name) => !MODE_OUTCOMES.dispatch.includes(name) && !ENGINE_OUTCOMES.includes(name),
      )
      if (own !== undefined)
        fail(`${path}.outcomes.${own}: a dispatch rule ends only on succeeded or blocked_manual`)
    }
    if (Object.keys(outcomes).every((name) => ENGINE_OUTCOMES.includes(name)))
      fail(`${path}.outcomes must name at least one way for the agent to finish`)
    // Every rule can end on these; they go to the failure station unless it says otherwise.
    for (const name of ENGINE_OUTCOMES) outcomes[name] ??= failure
    const session = (raw['session'] ?? 'fresh') as RuleSession
    if (!SESSIONS.includes(session)) fail(`${path}.session must be one of ${SESSIONS.join(', ')}`)
    return {
      id,
      watch,
      ...(claim === undefined ? {} : { claim }),
      agent,
      mode,
      maxAttempts: positive(raw, 'maxAttempts', ctx.defaultMaxAttempts, path),
      outcomes,
      prompt: raw['prompt'] === undefined ? defaultPrompt(mode) : text('prompt'),
      session,
    }
  })
  for (const [i, rule] of rules.entries()) {
    const other = rules.findIndex((r, j) => j !== i && (r.id === rule.id || r.watch === rule.watch))
    if (other > i)
      fail(
        rules[other]?.id === rule.id
          ? `rules: two rules are called ${rule.id}`
          : `rules: ${rule.id} and ${rules[other]?.id} both watch ${rule.watch}`,
      )
  }
  return rules
}

const FIELDS = ['workflow', 'rules', 'labels']

// Throws InvalidInput naming the field, the station or the rule at fault.
export function parseFlow(raw: unknown, ctx: FlowContext): Flow {
  if (!isObject(raw)) return fail('the flow must be an object')
  for (const key of Object.keys(raw))
    if (!FIELDS.includes(key)) fail(`${key}: not part of the flow (${FIELDS.join(', ')})`)
  const { workflow: parsed, statuses } = parseWorkflow(raw['workflow'])
  const labels = raw['labels'] ?? {}
  const holdLabel = (isObject(labels) ? labels['hold'] : undefined) ?? 'hold'
  // Jira labels cannot hold spaces.
  if (typeof holdLabel !== 'string' || !/^\S+$/.test(holdLabel))
    fail('labels.hold must be one word with no spaces')
  const rules = parseRules(
    raw['rules'],
    parsed.statuses.map((s) => s.id),
    ctx,
    parsed.roles.failure,
  )
  // Sending work back means leaving feedback for the rework rule's agent, so the station it
  // watches is where the board asks for that feedback (D86).
  const reworkAt = [...new Set(rules.filter((r) => r.mode === 'rework').map((r) => r.watch))]
  if (reworkAt.length > 1)
    fail(`rules: rework rules must watch one status, not ${reworkAt.join(', ')}`)
  const workflow: Workflow =
    reworkAt[0] === undefined
      ? parsed
      : { ...parsed, roles: { ...parsed.roles, rework: reworkAt[0] } }
  // The tasks a splitting or reworking agent can make start in one of these.
  const splitter = rules.find((r) => r.mode === 'split' || r.mode === 'rework')
  const missing = ['to-do', 'manual'].filter((s) => statuses.task?.[s] === undefined)
  if (splitter !== undefined && missing.length > 0)
    fail(`workflow.taskStatuses must map ${missing.join(', ')}: rule ${splitter.id} makes tasks`)
  // The engine moves a dispatched task through these (D102).
  const dispatcher = rules.find((r) => r.mode === 'dispatch')
  const undispatched = ['to-do', 'in-progress', 'manual', 'done'].filter(
    (s) => statuses.task?.[s] === undefined,
  )
  if (dispatcher !== undefined && undispatched.length > 0)
    fail(
      `workflow.taskStatuses must map ${undispatched.join(', ')}: rule ${dispatcher.id} runs tasks`,
    )
  // An executing agent walks every task status, and a custom one may.
  const executor = rules.find((r) => r.mode === 'execute' || r.mode === 'custom')
  const unmapped = TASK_STATUSES.filter((s) => statuses.task?.[s] === undefined)
  if (executor !== undefined && unmapped.length > 0)
    fail(`workflow.taskStatuses must map ${unmapped.join(', ')}: rule ${executor.id} runs tasks`)
  return { workflow, statuses, rules, holdLabel: holdLabel as string }
}

// The flow in use, swapped whole on a save: each request and each poll round reads it once,
// and a Run keeps the rule it was started with.
export interface LiveFlow {
  // What it is checked against from the file.
  readonly context: FlowContext
  current(): Flow
  // What the settings page edits: the flow as saved, or the default before any save.
  saved(): { version?: number; flow: unknown }
  // Statuses keyed to something the tracker does not hold; the engine starts nothing until
  // there are none (D91).
  unmatched: readonly string[]
  // Reads the current mapping on every call, so a tracker holding it follows a save.
  statuses: StatusMap
  save(
    deps: { tracker: TrackerPort; store: StorePort },
    actor: Account,
    expected: number | undefined,
    raw: unknown,
  ): Promise<FlowVersion>
}

export function createLiveFlow(
  ctx: FlowContext,
  initial: { flow: Flow; raw: unknown; version?: number },
): LiveFlow {
  let flow = initial.flow
  let map = createStatusMap(flow.statuses)
  let saved: { version?: number; flow: unknown } =
    initial.version === undefined
      ? { flow: initial.raw }
      : { version: initial.version, flow: initial.raw }
  const live: LiveFlow = {
    context: ctx,
    current: () => flow,
    saved: () => saved,
    unmatched: [],
    statuses: {
      toTracker: (kind, status) => map.toTracker(kind, status),
      fromTracker: (kind, key) => map.fromTracker(kind, key),
      mapped: (kind) => map.mapped(kind),
    },
    async save(deps, actor, expected, raw) {
      assertEditsFlow(actor)
      const next = parseFlow(raw, ctx)
      const version = await saveFlow(deps, actor, flow.statuses, {
        expected,
        flow: raw,
        mapping: next.statuses,
      })
      flow = next
      map = createStatusMap(next.statuses)
      saved = { version: version.version, flow: raw }
      live.unmatched = []
      return version
    },
  }
  return live
}

// The flow as last saved, or the default; a saved one the file no longer fits (an agent its
// rules use was renamed) stops the start, since only the file can put that right.
export async function loadFlow(store: StorePort, ctx: FlowContext): Promise<LiveFlow> {
  const latest = await store.latestFlow()
  const raw = latest?.flow ?? DEFAULT_FLOW
  let flow: Flow
  try {
    flow = parseFlow(raw, ctx)
  } catch (e) {
    throw new Error(
      `the flow saved in the store does not fit this config file: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  return createLiveFlow(ctx, {
    flow,
    raw,
    ...(latest === undefined ? {} : { version: latest.version }),
  })
}
