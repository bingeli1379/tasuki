<script setup lang="ts">
import type { Roles } from '@tasuki/core'
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { ApiError, call, messageOf, sendJson, type Account, type AuthState, type Item } from './api'
import AccountMenu from './components/AccountMenu.vue'
import Accounts from './components/Accounts.vue'
import General from './components/General.vue'
import ItemDetail from './components/ItemDetail.vue'
import Settings from './components/Settings.vue'
import SignIn from './components/SignIn.vue'
import { EDITOR_PROPS, EDITOR_TOOLBAR, MARKDOWN_OPTIONS, toStoredMarkdown } from './editor'
import { previewText } from './markdown'

interface Column {
  status: string
  displayName: string
  handledBy?: 'engine' | 'person'
  // Where a person can send the item from this status, the last the main choice.
  outcomes: string[]
  items: Item[]
}

const HANDLED_BY = {
  engine: {
    icon: 'i-lucide-radar',
    color: 'text-info',
    hint: 'An agent picks items up from here on its own',
  },
  person: { icon: 'i-lucide-eye', color: 'text-warning', hint: 'Waiting for a person' },
} as const

const auth = ref<AuthState>()
const signedIn = computed(() => auth.value?.mode === 'none' || auth.value?.me !== undefined)

const columns = ref<Column[]>([])
// Refs an agent is working on right now, and of those the ones told to stop.
const running = ref<string[]>([])
const stopping = ref<string[]>([])
const loaded = ref(false)
const holdLabel = ref('hold')
const paused = ref(false)
// Statuses keyed to something the tracker lacks: the engine starts nothing until they are
// mapped on the settings page (D91).
const unmatched = ref<string[]>([])
const settingsOpen = ref(false)
const generalOpen = ref(false)
const accountsOpen = ref(false)
const editsFlow = computed(
  () =>
    auth.value?.mode === 'none' ||
    (auth.value?.me !== undefined && auth.value.me.access !== 'member'),
)
// The gear holds what is the instance's, each item for whoever may change it; what is your
// own stays under your name (D105).
const isAdmin = computed(() => auth.value?.mode === 'none' || auth.value?.me?.access === 'admin')
const settingsItems = computed(() => [
  ...(editsFlow.value ? [{ label: 'Workflow', onSelect: () => (settingsOpen.value = true) }] : []),
  ...(isAdmin.value ? [{ label: 'General', onSelect: () => (generalOpen.value = true) }] : []),
  ...(isAdmin.value && auth.value?.me !== undefined
    ? [{ label: 'Accounts', onSelect: () => (accountsOpen.value = true) }]
    : []),
])
const roles = ref<Roles>()
const tasks = ref<Record<string, { done: number; total: number }>>({})
// Items a Run sent off on failing or giving up, while they are still where it put them.
const failed = ref<
  Record<string, { outcome: 'failed' | 'max_attempts'; rule: string; attempts: number }>
>({})
const error = ref('')
const open = ref(false)
const title = ref('')
const body = ref('')
const saving = ref(false)
const dragging = ref<Item>()
// Refs with a move in flight. A second move would carry a stale `from` and hit a conflict
// the person caused themselves, so the card is locked until the first one answers.
const pending = ref<string[]>([])
const over = ref<string>()
// The column a drop would actually move the card to; its own column is not one.
const target = computed(() =>
  dragging.value && over.value !== dragging.value.status ? over.value : undefined,
)
const toast = useToast()
// A constant, not a literal in the template: a new object each render rebuilds the editor.
// Height and padding go on the editable element, so all of the box takes a click.
const newItemEditorUi = {
  content: 'markdown [&_.ProseMirror]:min-h-40 [&_.ProseMirror]:px-3 [&_.ProseMirror]:py-2',
}
const detailOpen = ref(false)
const detailRef = ref('')
const boardEl = useTemplateRef('boardEl')

const allItems = computed(() => columns.value.flatMap((c) => c.items))
const detailItem = computed(() => allItems.value.find((i) => i.ref === detailRef.value))
// What the board knows about the open item; the detail reads itself again when it changes.
const detailSeen = computed(() => {
  const i = detailItem.value
  const r = detailRef.value
  return i
    ? `${i.status}|${i.version}|${i.labels.join()}|${running.value.includes(r)}|${stopping.value.includes(r)}`
    : ''
})

// Our own writes, until the board's search has caught up with them (D54). Until then a reload
// still lists the card as it was before, or not at all, and would undo it on screen for a
// moment. `before` is what the board showed then: once it lists anything else, it is newer
// than us, the engine's move included, and wins.
const recent = new Map<string, { item: Item | null; before: string | undefined; at: number }>()
const stateOf = (i: Item | undefined): string | undefined =>
  i === undefined ? undefined : `${i.status}|${i.version}`
function remember(item: Item | null, ref: string, before: Item | undefined): void {
  recent.set(ref, { item, before: stateOf(before), at: Date.now() })
}

function openDetail(item: Item): void {
  detailRef.value = item.ref
  detailOpen.value = true
}

const statusName = (status: string): string =>
  columns.value.find((c) => c.status === status)?.displayName ?? status

// Puts the card in the column its status names: in place when it is already there (an
// edit), at the end when it moved.
function place(item: Item): void {
  const target = columns.value.find((c) => c.status === item.status)
  const at = target?.items.findIndex((i) => i.ref === item.ref) ?? -1
  if (target && at >= 0) {
    target.items[at] = item
    return
  }
  for (const column of columns.value) column.items = column.items.filter((i) => i.ref !== item.ref)
  target?.items.push(item)
}

async function load(): Promise<void> {
  try {
    const board = await call<{
      columns: Column[]
      running: string[]
      stopping: string[]
      tasks: Record<string, { done: number; total: number }>
      holdLabel: string
      roles: Roles
      paused: boolean
      unmatched: string[]
      failed: Record<string, { outcome: 'failed' | 'max_attempts'; rule: string; attempts: number }>
    }>('/api/board')
    columns.value = board.columns
    for (const [ref, mine] of recent) {
      const listed = stateOf(board.columns.flatMap((c) => c.items).find((i) => i.ref === ref))
      if (Date.now() - mine.at > 60_000 || listed !== mine.before) {
        recent.delete(ref)
        continue
      }
      if (mine.item) place(mine.item)
      else
        for (const column of columns.value) column.items = column.items.filter((i) => i.ref !== ref)
    }
    loaded.value = true
    running.value = board.running
    stopping.value = board.stopping
    holdLabel.value = board.holdLabel
    paused.value = board.paused
    unmatched.value = board.unmatched
    failed.value = board.failed
    roles.value = board.roles
    tasks.value = board.tasks
    error.value = ''
  } catch (e) {
    error.value = messageOf(e)
  }
}

// The engine moves items on its own, so the board reads itself again every few seconds.
// Not while a card is in someone's hand, and not right after a write of ours: the board can
// lag behind writes (D54) and would put the card back where it was for a moment.
// Not while the tab is hidden either, since each read is a search against the tracker;
// coming back reads at once.
const REFRESH_MS = 5000
let lastWrite = 0
const wrote = (): void => {
  lastWrite = Date.now()
}
function reload(): void {
  if (!signedIn.value) return
  if (document.hidden || dragging.value || pending.value.length > 0) return
  if (Date.now() - lastWrite < REFRESH_MS) return
  void load()
}
const refresh = setInterval(reload, REFRESH_MS)
document.addEventListener('visibilitychange', reload)
onUnmounted(() => {
  clearInterval(refresh)
  document.removeEventListener('visibilitychange', reload)
})

// The global pause (stop-and-recovery.md); kill also stops every agent working now.
async function setPaused(action: 'pause' | 'kill' | 'resume'): Promise<void> {
  try {
    await call(
      `/api/engine/${action === 'resume' ? 'resume' : 'pause'}`,
      sendJson('POST', { kill: action === 'kill' }),
    )
    paused.value = action !== 'resume'
    error.value = ''
  } catch (e) {
    toast.add({ title: messageOf(e), color: 'error' })
  }
}

// A form opened again starts empty, not with what was typed and left last time.
watch(open, (isOpen) => {
  if (!isOpen) return
  title.value = ''
  body.value = ''
})

async function create(): Promise<void> {
  saving.value = true
  try {
    const item = await call<Item>(
      '/api/items',
      sendJson('POST', { title: title.value, body: toStoredMarkdown(body.value) }),
    )
    // Not a reload: the board may lag behind writes (Jira search index).
    columns.value.find((c) => c.status === item.status)?.items.push(item)
    remember(item, item.ref, undefined)
    wrote()
    title.value = ''
    body.value = ''
    error.value = ''
    open.value = false
  } catch (e) {
    toast.add({ title: messageOf(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

// The rework status takes a word on what to fix, wherever the move comes from: the agent
// has nothing else to go on (D75).
const reworkOf = ref<Item>()
const reworkNote = ref('')
const reworkOpen = computed({
  get: () => reworkOf.value !== undefined,
  set: (value) => {
    if (!value) reworkOf.value = undefined
  },
})

async function sendRework(): Promise<void> {
  const item = reworkOf.value
  const to = roles.value?.rework
  if (!item || to === undefined) return
  reworkOf.value = undefined
  await move(item, to, reworkNote.value)
}

async function move(item: Item, to: string, feedback?: string): Promise<void> {
  if (item.status === to || pending.value.includes(item.ref)) return
  if (to === roles.value?.rework && feedback === undefined) {
    reworkNote.value = ''
    reworkOf.value = item
    return
  }
  pending.value.push(item.ref)
  // Moved right away: a Jira move takes a few seconds and the card should not sit still.
  place({ ...item, status: to })
  try {
    // Not a reload, for the same reason as create.
    const moved = await call<Item>(
      `/api/items/${item.ref}/${feedback === undefined ? 'transition' : 'rework'}`,
      sendJson('POST', { from: item.status, to, feedback }),
    )
    place(moved)
    remember(moved, item.ref, item)
    error.value = ''
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.data.item) {
      const now = e.data.item
      place(now)
      const column = columns.value.find((c) => c.status === now.status)
      toast.add({
        title: `${now.ref} was just moved by someone else`,
        description: column
          ? `It is in ${column.displayName} now. Move it again if you still want to.`
          : `Its status is ${now.status}, which is not on this board.`,
        color: 'warning',
      })
      return
    }
    place(item)
    toast.add({ title: messageOf(e), color: 'error' })
  } finally {
    pending.value = pending.value.filter((r) => r !== item.ref)
    wrote()
  }
}

function drop(to: string): void {
  if (dragging.value) void move(dragging.value, to)
  dragging.value = undefined
  over.value = undefined
}

// Near either edge while dragging, the board scrolls, so a column out of view can be reached.
function edgeScroll(e: DragEvent): void {
  const el = boardEl.value
  if (!el || !dragging.value) return
  const { left, right } = el.getBoundingClientRect()
  if (e.clientX < left + 80) el.scrollLeft -= 24
  else if (e.clientX > right - 80) el.scrollLeft += 24
}

function updated(item: Item): void {
  remember(
    item,
    item.ref,
    allItems.value.find((i) => i.ref === item.ref),
  )
  place(item)
  wrote()
}

function deleted(ref: string): void {
  remember(
    null,
    ref,
    allItems.value.find((i) => i.ref === ref),
  )
  for (const column of columns.value) column.items = column.items.filter((i) => i.ref !== ref)
  wrote()
}

// dragleave also fires when the pointer moves onto a card inside the column.
function leave(e: DragEvent, status: string): void {
  const column = e.currentTarget as Node
  if (over.value === status && !column.contains(e.relatedTarget as Node | null))
    over.value = undefined
}

// Same storage key and values as Nuxt UI's color-mode plugin (VueUse useDark), which reads
// them on the next load.
const SCHEME_KEY = 'vueuse-color-scheme'
function initialDark(): boolean {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(SCHEME_KEY)
  } catch {
    // Storage blocked: follow the system.
  }
  if (stored === 'dark' || stored === 'light') return stored === 'dark'
  return matchMedia('(prefers-color-scheme: dark)').matches
}
const dark = ref(initialDark())

function toggleTheme(e: MouseEvent): void {
  const apply = (): void => {
    dark.value = !dark.value
    document.documentElement.classList.toggle('dark', dark.value)
    try {
      localStorage.setItem(SCHEME_KEY, dark.value ? 'dark' : 'light')
    } catch {
      // Storage blocked: the switch lasts until the page reloads.
    }
  }
  const root = document.documentElement.style
  root.setProperty('--reveal-x', `${e.clientX}px`)
  root.setProperty('--reveal-y', `${e.clientY}px`)
  if (
    typeof document.startViewTransition !== 'function' ||
    matchMedia('(prefers-reduced-motion: reduce)').matches
  )
    apply()
  else document.startViewTransition(apply)
}

async function start(): Promise<void> {
  try {
    auth.value = await call<AuthState>('/api/auth/state')
  } catch (e) {
    error.value = messageOf(e)
    auth.value = { mode: 'none', needsSetup: false }
  }
  if (signedIn.value) await load()
}

function enter(me: Account): void {
  if (auth.value) auth.value = { ...auth.value, needsSetup: false, me }
  void load()
}

onMounted(start)
</script>

<template>
  <UApp>
    <SignIn v-if="auth && !signedIn" :state="auth" @signed-in="enter" />
    <template v-else-if="auth">
      <div class="flex min-h-screen flex-col bg-muted">
        <header class="flex items-center justify-between px-6 pt-5 pb-3">
          <h1
            class="flex items-center gap-3 text-2xl font-extrabold tracking-tight text-highlighted"
            style="font-stretch: 78%"
          >
            <span
              aria-hidden="true"
              class="block h-6 w-2.5 -skew-x-[28deg] rounded-[3px] bg-sash"
            />
            <!-- On a phone the sash alone, so the buttons fit on one line. -->
            <span class="sr-only sm:not-sr-only">Tasuki</span>
          </h1>
          <span class="flex items-center gap-2">
            <UButton
              v-if="paused"
              label="Resume"
              color="neutral"
              variant="outline"
              @click="setPaused('resume')"
            />
            <UDropdownMenu
              v-else
              :content="{ align: 'start' }"
              :ui="{ itemLeadingIcon: 'size-4' }"
              :items="[
                { label: 'Pause', onSelect: () => setPaused('pause') },
                {
                  label: 'Pause and stop all agents',
                  color: 'error',
                  onSelect: () => setPaused('kill'),
                },
              ]"
            >
              <UButton
                label="Pause"
                color="neutral"
                variant="outline"
                trailing-icon="i-lucide-chevron-down"
              />
            </UDropdownMenu>
            <UModal v-model:open="open" title="New item" :ui="{ content: 'sm:max-w-3xl' }">
              <UButton label="New item" />
              <template #body>
                <!-- Only the title is a form, so Enter there creates the item; the editor toolbar
                 buttons would submit a form around them. -->
                <div class="flex flex-col gap-4">
                  <form @submit.prevent="create">
                    <UFormField label="Title" required>
                      <UInput v-model="title" required autofocus class="w-full" />
                    </UFormField>
                  </form>
                  <div class="flex flex-col gap-1">
                    <span class="text-sm font-medium">Body</span>
                    <UEditor
                      v-slot="{ editor }"
                      v-model="body"
                      content-type="markdown"
                      :markdown="MARKDOWN_OPTIONS"
                      :image="false"
                      :mention="false"
                      :editor-props="EDITOR_PROPS"
                      class="rounded-md border border-default"
                      :ui="newItemEditorUi"
                    >
                      <UEditorToolbar
                        :editor="editor"
                        :items="EDITOR_TOOLBAR"
                        class="border-b border-default px-2 py-1"
                      />
                    </UEditor>
                  </div>
                  <UButton
                    label="Create"
                    :loading="saving"
                    :disabled="title.trim() === ''"
                    class="self-end"
                    @click="create"
                  />
                </div>
              </template>
            </UModal>
            <UTooltip
              :text="dark ? 'Switch to light mode' : 'Switch to dark mode'"
              :delay-duration="100"
            >
              <UButton
                :icon="dark ? 'i-lucide-sun' : 'i-lucide-moon'"
                :aria-label="dark ? 'Switch to light mode' : 'Switch to dark mode'"
                color="neutral"
                variant="ghost"
                @click="toggleTheme"
              />
            </UTooltip>
            <UDropdownMenu v-if="editsFlow" :items="settingsItems" :content="{ align: 'end' }">
              <UButton
                icon="i-lucide-settings"
                aria-label="Settings"
                color="neutral"
                variant="ghost"
              />
            </UDropdownMenu>
            <Settings v-if="editsFlow" v-model:open="settingsOpen" @saved="load" />
            <General v-if="isAdmin" v-model:open="generalOpen" />
            <Accounts
              v-if="isAdmin && auth.me"
              v-model:open="accountsOpen"
              :me="auth.me"
              :keeps-accounts="auth.mode === 'builtin'"
            />
            <AccountMenu v-if="auth.mode !== 'none' && auth.me" :me="auth.me" :mode="auth.mode" />
          </span>
        </header>

        <main class="flex flex-1 flex-col px-6 pt-2 pb-6">
          <UAlert v-if="error" color="error" variant="subtle" :title="error" class="mb-4" />
          <UAlert
            v-if="paused"
            color="warning"
            variant="subtle"
            title="The engine is paused: no agent starts on any item until you resume it."
            class="mb-4"
          />
          <UAlert
            v-if="unmatched.length > 0"
            color="warning"
            variant="subtle"
            :title="`${unmatched.length} ${unmatched.length === 1 ? 'status is' : 'statuses are'} not matched to the tracker yet, so no agent starts: ${unmatched.join(', ')}.`"
            :actions="
              editsFlow ? [{ label: 'Open settings', onClick: () => (settingsOpen = true) }] : []
            "
            class="mb-4"
          />

          <p v-if="!loaded && !error" class="flex items-center gap-2 text-sm text-muted">
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
            Loading the board…
          </p>
          <div
            ref="boardEl"
            class="scrollbar-always flex flex-1 items-stretch gap-4 overflow-x-auto p-1 pb-4"
            @dragover="edgeScroll"
          >
            <section
              v-for="column in columns"
              :key="column.status"
              :aria-labelledby="`column-${column.status}`"
              class="flex w-72 shrink-0 flex-col gap-2 rounded-2xl p-2.5 transition-[background-color,box-shadow] duration-200"
              :class="
                target === column.status ? 'bg-primary/10 ring-2 ring-primary' : 'bg-(--lane)'
              "
              @dragenter.prevent="over = column.status"
              @dragleave="leave($event, column.status)"
              @dragover.prevent
              @drop.prevent="drop(column.status)"
            >
              <h2
                class="flex items-center justify-between px-1.5 pt-1 pb-1 text-[15px] font-semibold"
              >
                <span class="flex items-center gap-1.5">
                  <UTooltip
                    v-if="column.handledBy"
                    :text="HANDLED_BY[column.handledBy].hint"
                    :delay-duration="100"
                  >
                    <span
                      role="img"
                      :aria-label="HANDLED_BY[column.handledBy].hint"
                      class="flex cursor-help"
                    >
                      <UIcon
                        :name="HANDLED_BY[column.handledBy].icon"
                        class="size-4"
                        :class="HANDLED_BY[column.handledBy].color"
                      />
                    </span>
                  </UTooltip>
                  <span :id="`column-${column.status}`">{{ column.displayName }}</span>
                </span>
                <span class="text-sm font-medium text-dimmed">{{ column.items.length }}</span>
              </h2>
              <TransitionGroup name="card" tag="div" class="flex flex-col gap-2">
                <article
                  v-for="item in column.items"
                  :key="item.ref"
                  :aria-label="item.title"
                  :draggable="!pending.includes(item.ref)"
                  class="card-frame rounded-[calc(var(--radius-xl)+1.5px)] p-[1.5px] transition-colors duration-150"
                  :class="{
                    'opacity-60': pending.includes(item.ref),
                    'agent-ring': running.includes(item.ref),
                    'agent-ring-stopping': stopping.includes(item.ref),
                    'agent-failed': failed[item.ref] && !running.includes(item.ref),
                  }"
                  @dragstart="dragging = item"
                  @dragend="((dragging = undefined), (over = undefined))"
                >
                  <div
                    class="relative rounded-xl bg-default p-3 shadow-[0_1px_2px_rgb(22_26_46/0.06)]"
                  >
                    <div class="flex items-center justify-between">
                      <p class="flex items-center gap-2 text-xs text-muted">
                        <span class="font-medium text-dimmed">{{ item.ref }}</span>
                        <UBadge
                          v-if="running.includes(item.ref)"
                          :label="stopping.includes(item.ref) ? 'Stopping' : 'Running'"
                          :color="stopping.includes(item.ref) ? 'error' : 'primary'"
                          variant="subtle"
                          size="sm"
                        />
                        <UTooltip
                          v-if="failed[item.ref] && !running.includes(item.ref)"
                          :text="`Rule ${failed[item.ref]?.rule} moved it here. Open it to see why.`"
                          :delay-duration="100"
                        >
                          <UBadge
                            :label="
                              failed[item.ref]?.outcome === 'max_attempts'
                                ? `Gave up after ${failed[item.ref]?.attempts} tries`
                                : 'Failed'
                            "
                            icon="i-lucide-circle-x"
                            color="error"
                            variant="subtle"
                            size="sm"
                            class="relative z-10"
                          />
                        </UTooltip>
                        <UBadge
                          v-if="item.labels.includes(holdLabel)"
                          label="On hold"
                          color="warning"
                          variant="subtle"
                          size="sm"
                        />
                        <UBadge
                          v-if="tasks[item.ref]"
                          :label="`${tasks[item.ref]?.done}/${tasks[item.ref]?.total} tasks`"
                          color="neutral"
                          variant="outline"
                          size="sm"
                        />
                      </p>
                    </div>
                    <!-- Its ::after covers the whole card, so a click anywhere opens the item while
                     keyboard users still get one focusable button; moving without dragging is
                     in the item's own More menu. -->
                    <button
                      type="button"
                      class="mt-1 cursor-pointer text-left leading-snug font-semibold text-highlighted after:absolute after:inset-0 after:rounded-xl hover:text-primary focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-primary"
                      @click="openDetail(item)"
                    >
                      {{ item.title }}
                    </button>
                    <p v-if="item.body" class="mt-1 line-clamp-3 text-sm text-muted">
                      {{ previewText(item.body) }}
                    </p>
                  </div>
                </article>
              </TransitionGroup>
              <div
                v-if="target === column.status"
                class="rounded-md border-2 border-dashed border-primary p-3 text-center text-sm text-primary"
              >
                Drop here
              </div>
            </section>
          </div>
        </main>
      </div>
      <!-- Keyed: each item gets a fresh editor, whose image extension is bound to its ref. -->
      <ItemDetail
        v-if="detailRef && roles"
        :key="detailRef"
        v-model:open="detailOpen"
        :item-ref="detailRef"
        :status-name="statusName"
        :hold-label="holdLabel"
        :initial="detailItem"
        :seen="detailSeen"
        :columns="columns"
        :roles="roles"
        @updated="updated"
        @move="(to) => detailItem && move(detailItem, to)"
        @deleted="deleted"
      />
      <!-- After ItemDetail: opened from its More menu, it has to sit above the detail. -->
      <UModal
        v-model:open="reworkOpen"
        :title="`Send ${reworkOf?.ref ?? ''} back for rework`"
        description="The agent makes new tasks from this alone, so say what is wrong and what you expect."
      >
        <template #body>
          <form class="flex flex-col gap-3" @submit.prevent="sendRework">
            <UFormField label="What to rework">
              <UTextarea v-model="reworkNote" :rows="4" autoresize autofocus class="w-full" />
            </UFormField>
            <span class="flex justify-end gap-2">
              <UButton
                label="Cancel"
                color="neutral"
                variant="outline"
                @click="reworkOf = undefined"
              />
              <UButton
                type="submit"
                label="Send back for rework"
                :disabled="reworkNote.trim() === ''"
              />
            </span>
          </form>
        </template>
      </UModal>
    </template>
  </UApp>
</template>
