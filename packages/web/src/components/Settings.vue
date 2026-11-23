<script setup lang="ts">
import {
  defaultStationName,
  ENGINE_OUTCOMES,
  MODE_OUTCOMES,
  TASK_STATUS_DISPLAY,
  TASK_STATUSES,
  type RuleMode,
} from '@tasuki/core'
import { computed, ref, watch } from 'vue'
import { ApiError, call, messageOf, sendJson } from '../api'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()

interface StationDraft {
  id: string
  name: string
  // '' while no tracker status is picked; only a tracker with a fixed set has one.
  key: string
  person: boolean
  outcomes: string[]
  // Set while the id still follows the name, which it does until a station is first saved.
  fresh?: boolean
  // The id the rules, buttons and roles point at. It follows id only while id is filled in
  // and no other status has it, so typing through a blank or a clash loses no reference.
  linked: string
}

interface RuleDraft {
  id: string
  watch: string
  claim: string
  agent: string
  mode: RuleMode
  // null: the file's defaultMaxAttempts.
  maxAttempts: number | null
  session: 'fresh' | 'per-item'
  // Outcome name -> station, '' for unset.
  outcomes: Record<string, string>
  prompt: string
}

interface SettingChange {
  text: string
  // A prompt's text before and after, '' for its default.
  before?: string
  after?: string
}

interface SavedVersion {
  version: number
  flow: Record<string, unknown>
  savedBy: string
  savedAt: string
  changes: SettingChange[]
}

interface TrackerStatus {
  key: string
  name: string
}

interface FlowResponse {
  version?: number
  flow: Record<string, unknown>
  agents: string[]
  // What a rule with no attempts of its own gets, from the config file.
  defaultMaxAttempts: number
  prompts: Record<RuleMode, string>
  // null: the tracker takes any key, and a station is keyed by its id.
  trackerStatuses: { item: TrackerStatus[]; task: TrackerStatus[] } | null
}

// Keyed by every mode core has, so a new one fails the type check until it is named here.
const MODE_TEXT: Record<RuleMode, { label: string; hint: string }> = {
  split: { label: 'Split', hint: 'Breaks the item into tasks' },
  execute: { label: 'Execute', hint: 'Works through the tasks' },
  dispatch: { label: 'Dispatch', hint: 'One agent per task, run in parallel by the engine' },
  rework: { label: 'Rework', hint: 'Turns feedback into tasks' },
  review: { label: 'Review', hint: 'Reads and comments, then picks an outcome' },
  custom: { label: 'Custom', hint: 'Every tool, nothing checked: the prompt says it all' },
}
const MODES = (Object.keys(MODE_OUTCOMES) as RuleMode[]).map((value) => ({
  value,
  ...MODE_TEXT[value],
}))
// The outcomes tasuki knows, as a person reads them. One a rule adds shows its own name.
const OUTCOME_TEXT: Record<string, { label: string; hint: string }> = {
  succeeded: { label: 'Done', hint: 'The agent finished the job' },
  blocked_manual: { label: 'Only manual tasks left', hint: 'Waiting for a person to do them' },
  needs_input: { label: 'Needs an answer', hint: 'The agent asked a person something' },
  failed: { label: 'Failed', hint: 'Something went wrong' },
  max_attempts: { label: 'Gave up', hint: 'Tried too many times' },
}
const outcomeLabel = (name: string): string =>
  OUTCOME_TEXT[name]?.label ?? name.charAt(0).toUpperCase() + name.slice(1).replaceAll('_', ' ')

// A select option cannot be the empty string (Reka UI throws), and no station id or Jira
// status id is ever this.
const NONE = '_'

const loaded = ref<FlowResponse>()
const error = ref('')
const saving = ref(false)
const stations = ref<StationDraft[]>([])
const entry = ref('')
const failure = ref('')
const taskKeys = ref<Record<string, string>>({})
const hold = ref('hold')
const rules = ref<RuleDraft[]>([])
// One draft name per rule for an outcome of its own.
const newOutcome = ref<Record<number, string>>({})
const toast = useToast()
// W4b: the saves so far, newest first, shown instead of the form while looked at.
const view = ref<'form' | 'history'>('form')
const history = ref<SavedVersion[]>()
// The version put back in the form, until it is saved or the form reloaded.
const restored = ref<number>()

const kebab = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const stationItems = computed(() =>
  stations.value.filter((s) => s.id !== '').map((s) => ({ label: s.name || s.id, value: s.id })),
)
const trackerItems = computed(() =>
  (loaded.value?.trackerStatuses?.item ?? []).map((s) => ({ label: s.name, value: s.key })),
)
const taskTrackerItems = computed(() => [
  { label: 'Not used', value: NONE },
  ...(loaded.value?.trackerStatuses?.task ?? []).map((s) => ({ label: s.name, value: s.key })),
])
const failureName = computed(
  () => stations.value.find((s) => s.id === failure.value)?.name ?? failure.value,
)

function fromFlow(res: FlowResponse): void {
  const flow = res.flow as {
    workflow: {
      statuses: {
        id: string
        name?: string
        key?: string
        handledBy?: string
        outcomes?: string[]
      }[]
      roles: { entry: string; failure: string }
      taskStatuses?: Record<string, string>
    }
    rules?: (Omit<RuleDraft, 'claim' | 'prompt' | 'session' | 'maxAttempts'> & {
      maxAttempts?: number
      claim?: string
      prompt?: string
      session?: RuleDraft['session']
    })[]
    labels?: { hold?: string }
  }
  stations.value = flow.workflow.statuses.map((s) => ({
    id: s.id,
    name: s.name ?? defaultStationName(s.id),
    key: s.key ?? '',
    person: s.handledBy === 'person',
    outcomes: [...(s.outcomes ?? [])],
    linked: s.id,
  }))
  entry.value = flow.workflow.roles.entry
  failure.value = flow.workflow.roles.failure
  taskKeys.value = Object.fromEntries(
    TASK_STATUSES.map((s) => [s, flow.workflow.taskStatuses?.[s] ?? '']),
  )
  hold.value = flow.labels?.hold ?? 'hold'
  rules.value = (flow.rules ?? []).map((r) => ({
    ...r,
    claim: r.claim ?? '',
    maxAttempts: r.maxAttempts ?? null,
    prompt: r.prompt ?? '',
    session: r.session ?? 'fresh',
    outcomes: { ...r.outcomes },
  }))
  newOutcome.value = {}
}

async function load(): Promise<void> {
  try {
    const res = await call<FlowResponse>('/api/flow')
    loaded.value = res
    fromFlow(res)
    restored.value = undefined
    error.value = ''
  } catch (e) {
    error.value = messageOf(e)
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return
  // What was loaded last time could be stale; show nothing until this load answers.
  loaded.value = undefined
  error.value = ''
  view.value = 'form'
  void load()
})

async function showHistory(): Promise<void> {
  view.value = 'history'
  history.value = undefined
  try {
    history.value = (await call<{ versions: SavedVersion[] }>('/api/flow/history')).versions
  } catch (e) {
    view.value = 'form'
    toast.add({ title: messageOf(e), color: 'error' })
  }
}

// Into the form only: saving it is an ordinary save, checked like any other, as a new version.
function restore(saved: SavedVersion): void {
  if (!loaded.value) return
  fromFlow({ ...loaded.value, flow: saved.flow })
  restored.value = saved.version
  view.value = 'form'
}

// Back to the shape the server checks: what is left at its default is left out.
function toFlow(): unknown {
  const keyed = loaded.value?.trackerStatuses !== null
  return {
    workflow: {
      statuses: stations.value.map((s) => ({
        id: s.id,
        name: s.name,
        ...(keyed && s.key !== '' ? { key: s.key } : {}),
        ...(s.person ? { handledBy: 'person' } : {}),
        outcomes: s.outcomes,
      })),
      roles: { entry: entry.value, failure: failure.value },
      taskStatuses: Object.fromEntries(
        Object.entries(
          keyed ? taskKeys.value : Object.fromEntries(TASK_STATUSES.map((s) => [s, s])),
        ).filter(([, key]) => key !== ''),
      ),
    },
    rules: rules.value.map((r) => ({
      id: r.id,
      watch: r.watch,
      ...(r.claim === '' ? {} : { claim: r.claim }),
      agent: r.agent,
      mode: r.mode,
      ...(r.maxAttempts === null ? {} : { maxAttempts: r.maxAttempts }),
      ...(r.session === 'fresh' ? {} : { session: r.session }),
      outcomes: Object.fromEntries(Object.entries(r.outcomes).filter(([, to]) => to !== '')),
      ...(r.prompt.trim() === '' ? {} : { prompt: r.prompt }),
    })),
    labels: { hold: hold.value },
  }
}

async function save(): Promise<void> {
  saving.value = true
  try {
    const version = loaded.value?.version
    await call(
      '/api/flow',
      sendJson('PUT', { ...(version === undefined ? {} : { version }), flow: toFlow() }),
    )
    toast.add({ title: 'Saved: the engine follows it from its next round', color: 'success' })
    open.value = false
    emit('saved')
  } catch (e) {
    if (e instanceof ApiError && e.status === 409)
      toast.add({
        title: 'Someone else saved the settings meanwhile',
        description: 'Reload to see theirs; what you changed here is not kept.',
        color: 'error',
        actions: [{ label: 'Reload', onClick: () => void load() }],
      })
    else toast.add({ title: messageOf(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

const repeated = (ids: string[]): Set<string> =>
  new Set(ids.filter((id, i) => id !== '' && ids.indexOf(id) !== i))
const repeatedStations = computed(() => repeated(stations.value.map((s) => s.id)))
const repeatedRules = computed(() => repeated(rules.value.map((r) => r.id)))
const clashes = computed(() => repeatedStations.value.size + repeatedRules.value.size > 0)

// Everything pointing at the station moves with its id.
function setId(station: StationDraft, id: string): void {
  station.id = id
  const from = station.linked
  if (id === '' || id === from || stations.value.some((s) => s !== station && s.id === id)) return
  station.linked = id
  if (from === '') return
  const swap = (v: string): string => (v === from ? id : v)
  for (const s of stations.value) s.outcomes = s.outcomes.map(swap)
  entry.value = swap(entry.value)
  failure.value = swap(failure.value)
  for (const r of rules.value) {
    r.watch = swap(r.watch)
    r.claim = swap(r.claim)
    for (const [name, to] of Object.entries(r.outcomes)) r.outcomes[name] = swap(to)
  }
}

function rename(station: StationDraft, name: string): void {
  station.name = name
  if (station.fresh) setId(station, kebab(name))
}

function addStation(): void {
  stations.value.push({
    id: '',
    name: '',
    key: '',
    person: false,
    outcomes: [],
    fresh: true,
    linked: '',
  })
}

function moveStation(index: number, by: -1 | 1): void {
  const list = stations.value
  const [station] = list.splice(index, 1)
  if (station) list.splice(index + by, 0, station)
}

function addRule(): void {
  const agent = loaded.value?.agents[0] ?? ''
  rules.value.push({
    id: '',
    watch: '',
    claim: '',
    agent,
    mode: 'review',
    maxAttempts: null,
    session: 'fresh',
    outcomes: {},
    prompt: '',
  })
}

// The outcomes a rule shows: its mode's, the ones every rule has, then its own. A dispatch
// rule's item ends only where the engine sends it from its tasks (D102).
const outcomeNames = (rule: RuleDraft): string[] =>
  rule.mode === 'dispatch'
    ? [...MODE_OUTCOMES.dispatch]
    : [...new Set([...MODE_OUTCOMES[rule.mode], ...ENGINE_OUTCOMES, ...Object.keys(rule.outcomes)])]
const ownOutcome = (rule: RuleDraft, name: string): boolean =>
  !MODE_OUTCOMES[rule.mode].includes(name) && !ENGINE_OUTCOMES.includes(name)

function addOutcome(index: number, rule: RuleDraft): void {
  const name = (newOutcome.value[index] ?? '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
  if (name === '') return
  rule.outcomes[name] ??= ''
  newOutcome.value[index] = ''
}

// Rework works from what it did before, so it starts out continuing the item's last
// conversation; any other mode starts fresh. Picked by hand afterwards, it stays as picked.
function setMode(rule: RuleDraft, mode: RuleMode): void {
  rule.mode = mode
  rule.session = mode === 'rework' ? 'per-item' : 'fresh'
  if (mode === 'dispatch') {
    rule.claim = ''
    rule.outcomes = Object.fromEntries(
      Object.entries(rule.outcomes).filter(([name]) => MODE_OUTCOMES.dispatch.includes(name)),
    )
  }
}

function dropOutcome(rule: RuleDraft, name: string): void {
  const { [name]: _, ...rest } = rule.outcomes
  rule.outcomes = rest
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Settings"
    description="Statuses and rules. Saved, the engine follows them from its next round."
    :ui="{ content: 'sm:max-w-4xl', description: 'pe-8' }"
  >
    <template #body>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      <p v-else-if="!loaded" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        Loading the settings…
      </p>
      <section v-else-if="view === 'history'" aria-label="History" class="flex flex-col gap-3">
        <p v-if="!history" class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
          Loading the history…
        </p>
        <p v-else-if="history.length === 0" class="text-sm text-muted">
          Nothing saved yet: the engine runs on the default settings.
        </p>
        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="(v, i) in history"
            :key="v.version"
            :aria-label="`Version ${v.version}`"
            class="flex flex-col gap-2 rounded-md border border-default p-3"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="flex min-w-0 flex-wrap items-center gap-x-2 text-sm">
                <span class="font-medium">Version {{ v.version }}</span>
                <span class="text-muted">
                  {{ v.savedBy || 'Someone' }} ·
                  <time :datetime="v.savedAt">{{ new Date(v.savedAt).toLocaleString() }}</time>
                </span>
                <UBadge v-if="i === 0" label="In use" color="success" variant="subtle" size="sm" />
              </span>
              <UButton
                v-if="i > 0"
                label="Restore"
                icon="i-lucide-history"
                variant="outline"
                size="sm"
                @click="restore(v)"
              />
            </div>
            <p v-if="v.changes.length === 0" class="text-sm text-muted">Saved with no changes.</p>
            <ul v-else class="flex list-disc flex-col gap-1 ps-5 text-sm">
              <li v-for="(c, j) in v.changes" :key="j">
                <details v-if="c.before !== undefined">
                  <summary class="cursor-pointer">{{ c.text }}</summary>
                  <div class="mt-1 grid gap-2 sm:grid-cols-2">
                    <figure v-for="side in ['before', 'after'] as const" :key="side">
                      <figcaption class="text-xs text-muted">
                        {{ side === 'before' ? 'Before' : 'After' }}
                      </figcaption>
                      <pre
                        class="max-h-60 overflow-auto rounded bg-elevated p-2 text-xs whitespace-pre-wrap"
                        >{{ c[side] || 'The default for its mode' }}</pre>
                    </figure>
                  </div>
                </details>
                <span v-else>{{ c.text }}</span>
              </li>
            </ul>
          </li>
        </ul>
      </section>
      <div v-else-if="loaded" class="flex flex-col gap-8">
        <UAlert
          v-if="restored !== undefined"
          color="info"
          variant="subtle"
          icon="i-lucide-history"
          :title="`Version ${restored} is in the form`"
          description="Save to make it the one in use, as a new version."
        />
        <section aria-label="Statuses" class="flex flex-col gap-3">
          <h3 class="font-semibold text-highlighted">Statuses</h3>
          <p class="text-sm text-muted">
            In board order. Buttons are where a person can send an item from there.
          </p>
          <ul class="flex flex-col gap-2">
            <li
              v-for="(s, i) in stations"
              :key="i"
              :aria-label="s.name || 'New status'"
              class="flex flex-col gap-2 rounded-md border border-default p-3"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="truncate text-sm font-medium">{{ s.name || 'New status' }}</span>
                <span class="flex shrink-0 items-center gap-1">
                  <UButton
                    icon="i-lucide-arrow-up"
                    :aria-label="`Move ${s.name} up`"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    :disabled="i === 0"
                    @click="moveStation(i, -1)"
                  />
                  <UButton
                    icon="i-lucide-arrow-down"
                    :aria-label="`Move ${s.name} down`"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    :disabled="i === stations.length - 1"
                    @click="moveStation(i, 1)"
                  />
                  <UButton
                    icon="i-lucide-trash-2"
                    :aria-label="`Remove ${s.name}`"
                    color="error"
                    variant="ghost"
                    size="sm"
                    @click="stations.splice(i, 1)"
                  />
                </span>
              </div>
              <div class="grid gap-2 sm:grid-cols-3">
                <UFormField label="Name">
                  <UInput
                    :model-value="s.name"
                    class="w-full"
                    :autofocus="s.fresh === true"
                    @update:model-value="(v) => rename(s, String(v))"
                  />
                </UFormField>
                <UFormField
                  label="ID"
                  hint="Used by rules"
                  :error="repeatedStations.has(s.id) && 'Another status has this ID'"
                >
                  <UInput
                    :model-value="s.id"
                    class="w-full font-mono"
                    @update:model-value="(v) => setId(s, String(v))"
                  />
                </UFormField>
                <UFormField v-if="loaded.trackerStatuses" label="Tracker status">
                  <USelect
                    v-model="s.key"
                    :items="trackerItems"
                    placeholder="Pick one"
                    class="w-full"
                  />
                </UFormField>
              </div>
              <div class="grid items-end gap-2 sm:grid-cols-3">
                <UFormField label="Buttons" class="sm:col-span-2">
                  <USelectMenu
                    v-model="s.outcomes"
                    :items="stationItems.filter((x) => x.value !== s.id)"
                    value-key="value"
                    multiple
                    placeholder="None"
                    class="w-full"
                  />
                </UFormField>
                <UCheckbox
                  :model-value="s.person"
                  label="Waits for a person"
                  class="py-1.5"
                  @update:model-value="(v) => (s.person = v === true)"
                />
              </div>
            </li>
          </ul>
          <UButton
            label="Add a status"
            icon="i-lucide-plus"
            variant="outline"
            class="self-start"
            @click="addStation"
          />
          <div class="grid gap-2 sm:grid-cols-2">
            <UFormField label="New items start in">
              <USelect v-model="entry" :items="stationItems" class="w-full" />
            </UFormField>
            <UFormField label="When an agent fails, the item goes to">
              <USelect v-model="failure" :items="stationItems" class="w-full" />
            </UFormField>
          </div>
        </section>

        <section aria-label="Rules" class="flex flex-col gap-3">
          <h3 class="font-semibold text-highlighted">Rules</h3>
          <p class="text-sm text-muted">
            An agent picks up items in the status a rule watches. Its mode decides which tools the
            agent gets and what the engine checks before moving the item on.
          </p>
          <ul class="flex flex-col gap-3">
            <li
              v-for="(r, i) in rules"
              :key="i"
              :aria-label="r.id || 'New rule'"
              class="flex flex-col gap-3 rounded-md border border-default p-3"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="truncate font-mono text-sm font-medium">{{ r.id || 'New rule' }}</span>
                <UButton
                  icon="i-lucide-trash-2"
                  :aria-label="`Remove the rule ${r.id}`"
                  color="error"
                  variant="ghost"
                  size="sm"
                  @click="rules.splice(i, 1)"
                />
              </div>
              <div class="grid gap-2 sm:grid-cols-4">
                <UFormField
                  label="Name"
                  :error="repeatedRules.has(r.id) && 'Another rule has this name'"
                >
                  <UInput v-model="r.id" class="w-full font-mono" :autofocus="r.id === ''" />
                </UFormField>
                <UFormField label="Watches">
                  <USelect
                    v-model="r.watch"
                    :items="stationItems"
                    placeholder="Pick one"
                    class="w-full"
                  />
                </UFormField>
                <UFormField label="Agent">
                  <USelect v-model="r.agent" :items="loaded.agents" class="w-full" />
                </UFormField>
                <UFormField label="Mode">
                  <USelect
                    :model-value="r.mode"
                    :items="MODES"
                    class="w-full"
                    @update:model-value="(v) => setMode(r, v as RuleMode)"
                  />
                </UFormField>
              </div>
              <div class="flex flex-col gap-1">
                <span class="text-sm font-medium">Where the item goes</span>
                <div
                  v-for="name in outcomeNames(r)"
                  :key="name"
                  class="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 sm:grid-cols-3"
                >
                  <span class="col-span-2 flex flex-col sm:col-span-1">
                    <span class="text-sm">{{ outcomeLabel(name) }}</span>
                    <span v-if="OUTCOME_TEXT[name]" class="text-xs text-muted">{{
                      OUTCOME_TEXT[name]?.hint
                    }}</span>
                  </span>
                  <UFormField :label="`${r.id} ${name}`" :ui="{ label: 'sr-only' }">
                    <USelect
                      :model-value="r.outcomes[name] ?? ''"
                      :items="stationItems"
                      :placeholder="ENGINE_OUTCOMES.includes(name) ? failureName : 'Pick one'"
                      class="w-full"
                      @update:model-value="(v) => (r.outcomes[name] = String(v))"
                    />
                  </UFormField>
                  <UButton
                    v-if="ownOutcome(r, name)"
                    icon="i-lucide-x"
                    :aria-label="`Remove the outcome ${name}`"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    class="justify-self-start"
                    @click="dropOutcome(r, name)"
                  />
                </div>
                <form
                  v-if="r.mode !== 'dispatch'"
                  class="grid grid-cols-[1fr_auto] items-center gap-2 sm:grid-cols-3"
                  @submit.prevent="addOutcome(i, r)"
                >
                  <UFormField :label="`Another outcome for ${r.id}`" :ui="{ label: 'sr-only' }">
                    <UInput
                      :model-value="newOutcome[i] ?? ''"
                      placeholder="Another outcome, e.g. approve"
                      class="w-full"
                      @update:model-value="(v) => (newOutcome[i] = String(v))"
                    />
                  </UFormField>
                  <UButton type="submit" label="Add" variant="outline" class="justify-self-start" />
                </form>
              </div>
              <div class="grid gap-2 sm:grid-cols-3">
                <UFormField v-if="r.mode !== 'dispatch'" label="While working">
                  <USelect
                    :model-value="r.claim || NONE"
                    :items="[{ label: 'Leave it where it is', value: NONE }, ...stationItems]"
                    class="w-full"
                    @update:model-value="(v) => (r.claim = v === NONE ? '' : String(v))"
                  />
                </UFormField>
                <UFormField label="Attempts">
                  <UInputNumber
                    :model-value="r.maxAttempts"
                    :min="1"
                    :placeholder="`${loaded.defaultMaxAttempts} (default)`"
                    class="w-full"
                    @update:model-value="(v) => (r.maxAttempts = typeof v === 'number' ? v : null)"
                  />
                </UFormField>
                <UFormField label="Session">
                  <USelect
                    :model-value="r.session"
                    :items="[
                      { label: 'New conversation each run', value: 'fresh' },
                      { label: 'Continue the last one on this item', value: 'per-item' },
                    ]"
                    class="w-full"
                    @update:model-value="(v) => (r.session = v as RuleDraft['session'])"
                  />
                </UFormField>
              </div>
              <UFormField
                label="Prompt"
                :hint="
                  r.mode === 'custom'
                    ? 'Empty: only the engine’s contract'
                    : 'Empty: the default for its mode'
                "
              >
                <UTextarea
                  v-model="r.prompt"
                  :placeholder="
                    loaded.prompts[r.mode] ||
                    'Custom has no default: the agent gets only the engine\'s contract'
                  "
                  :rows="4"
                  :maxrows="10"
                  autoresize
                  class="w-full font-mono"
                />
              </UFormField>
            </li>
          </ul>
          <UButton
            label="Add a rule"
            icon="i-lucide-plus"
            variant="outline"
            class="self-start"
            :disabled="loaded.agents.length === 0"
            @click="addRule"
          />
        </section>

        <section
          v-if="loaded.trackerStatuses"
          aria-label="Task statuses"
          class="flex flex-col gap-3"
        >
          <h3 class="font-semibold text-highlighted">Task statuses in the tracker</h3>
          <p class="text-sm text-muted">
            Tasks always go through these five steps. Pick the tracker status each step is kept in,
            as Tracker status does for each status above. Not used: no task goes to that step.
          </p>
          <div class="grid gap-2 sm:grid-cols-3">
            <UFormField
              v-for="status in TASK_STATUSES"
              :key="status"
              :label="TASK_STATUS_DISPLAY[status] ?? status"
            >
              <USelect
                :model-value="taskKeys[status] || NONE"
                :items="taskTrackerItems"
                class="w-full"
                @update:model-value="(v) => (taskKeys[status] = v === NONE ? '' : String(v))"
              />
            </UFormField>
          </div>
        </section>

        <section aria-label="Hold" class="flex flex-col gap-3">
          <h3 class="font-semibold text-highlighted">Hold</h3>
          <UFormField
            label="Hold label"
            description="Put this label on an item and no agent touches it."
            class="sm:w-1/2"
          >
            <UInput v-model="hold" class="w-full" />
          </UFormField>
        </section>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center gap-2">
        <UButton
          v-if="view === 'form'"
          label="History"
          icon="i-lucide-history"
          color="neutral"
          variant="ghost"
          :disabled="!loaded"
          @click="showHistory"
        />
        <UButton
          v-else
          label="Back to the form"
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="ghost"
          @click="view = 'form'"
        />
        <span class="ms-auto flex gap-2">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
          <UButton
            label="Save"
            :loading="saving"
            :disabled="!loaded || clashes || view === 'history'"
            @click="save"
          />
        </span>
      </div>
    </template>
  </UModal>
</template>
