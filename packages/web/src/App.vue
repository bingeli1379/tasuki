<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ApiError, call, messageOf, sendJson, type Item } from './api'
import ItemDetail from './components/ItemDetail.vue'
import { EDITOR_PROPS, EDITOR_TOOLBAR, MARKDOWN_OPTIONS, toStoredMarkdown } from './editor'
import { previewText } from './markdown'

interface Column {
  status: string
  displayName: string
  turn?: 'engine' | 'person'
  items: Item[]
}

const TURN = {
  engine: {
    icon: 'i-lucide-radar',
    color: 'text-info',
    hint: 'An agent picks items up from here on its own',
  },
  person: { icon: 'i-lucide-eye', color: 'text-warning', hint: 'Waiting for a person' },
} as const

const columns = ref<Column[]>([])
// Refs an agent is working on right now.
const running = ref<string[]>([])
const tasks = ref<Record<string, { done: number; total: number }>>({})
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
      tasks: Record<string, { done: number; total: number }>
    }>('/api/board')
    columns.value = board.columns
    running.value = board.running
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

async function create(): Promise<void> {
  saving.value = true
  try {
    const item = await call<Item>(
      '/api/items',
      sendJson('POST', { title: title.value, body: toStoredMarkdown(body.value) }),
    )
    // Not a reload: the board may lag behind writes (Jira search index).
    columns.value.find((c) => c.status === item.status)?.items.push(item)
    wrote()
    title.value = ''
    body.value = ''
    error.value = ''
    open.value = false
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    saving.value = false
  }
}

async function move(item: Item, to: string): Promise<void> {
  if (item.status === to || pending.value.includes(item.ref)) return
  pending.value.push(item.ref)
  // Moved right away: a Jira move takes a few seconds and the card should not sit still.
  place({ ...item, status: to })
  try {
    // Not a reload, for the same reason as create.
    place(
      await call<Item>(
        `/api/items/${item.ref}/transition`,
        sendJson('POST', { from: item.status, to }),
      ),
    )
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
    error.value = messageOf(e)
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

// dragleave also fires when the pointer moves onto a card inside the column.
function leave(e: DragEvent, status: string): void {
  const column = e.currentTarget as Node
  if (over.value === status && !column.contains(e.relatedTarget as Node | null))
    over.value = undefined
}

onMounted(load)
</script>

<template>
  <UApp>
    <div class="flex min-h-screen flex-col bg-muted">
      <header
        class="flex items-center justify-between border-b border-default bg-default px-6 py-3"
      >
        <h1 class="text-lg font-semibold">Tasuki</h1>
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
      </header>

      <main class="flex flex-1 flex-col p-6">
        <UAlert v-if="error" color="error" variant="subtle" :title="error" class="mb-4" />

        <div class="scrollbar-always flex flex-1 items-stretch gap-4 overflow-x-auto p-1 pb-4">
          <section
            v-for="column in columns"
            :key="column.status"
            :aria-labelledby="`column-${column.status}`"
            class="flex w-72 shrink-0 flex-col gap-2 rounded-lg p-3 transition-colors"
            :class="target === column.status ? 'bg-primary/10 ring-2 ring-primary' : 'bg-elevated'"
            @dragenter.prevent="over = column.status"
            @dragleave="leave($event, column.status)"
            @dragover.prevent
            @drop.prevent="drop(column.status)"
          >
            <h2 class="flex items-center justify-between px-1 text-sm font-medium">
              <span class="flex items-center gap-1.5">
                <UTooltip v-if="column.turn" :text="TURN[column.turn].hint">
                  <span role="img" :aria-label="TURN[column.turn].hint" class="flex">
                    <UIcon
                      :name="TURN[column.turn].icon"
                      class="size-4"
                      :class="TURN[column.turn].color"
                    />
                  </span>
                </UTooltip>
                <span :id="`column-${column.status}`">{{ column.displayName }}</span>
              </span>
              <UBadge :label="column.items.length" color="neutral" variant="subtle" size="sm" />
            </h2>
            <article
              v-for="item in column.items"
              :key="item.ref"
              :aria-label="item.title"
              :draggable="!pending.includes(item.ref)"
              :class="{ 'opacity-60': pending.includes(item.ref) }"
              @dragstart="dragging = item"
              @dragend="((dragging = undefined), (over = undefined))"
            >
              <UCard :ui="{ root: 'relative', body: 'p-3 sm:p-3' }">
                <div class="flex items-center justify-between">
                  <p class="flex items-center gap-2 text-xs text-muted">
                    <span>{{ item.ref }}</span>
                    <UBadge
                      v-if="running.includes(item.ref)"
                      label="Running"
                      color="primary"
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
                  <UDropdownMenu
                    :items="
                      columns
                        .filter((c) => c.status !== column.status)
                        .map((c) => ({
                          label: c.displayName,
                          onSelect: () => move(item, c.status),
                        }))
                    "
                  >
                    <UButton
                      label="Move"
                      :aria-label="`Move ${item.title}`"
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      class="relative z-10"
                    />
                  </UDropdownMenu>
                </div>
                <!-- Its ::after covers the whole card, so a click anywhere opens the item while
                     keyboard users still get one focusable button. Move sits above it. -->
                <button
                  type="button"
                  class="cursor-pointer text-left font-medium after:absolute after:inset-0 after:rounded-lg hover:underline focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-primary"
                  @click="openDetail(item)"
                >
                  {{ item.title }}
                </button>
                <p v-if="item.body" class="mt-1 line-clamp-3 text-sm text-toned">
                  {{ previewText(item.body) }}
                </p>
              </UCard>
            </article>
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
      v-if="detailRef"
      :key="detailRef"
      v-model:open="detailOpen"
      :item-ref="detailRef"
      :status-name="statusName"
      @updated="(item) => (place(item), wrote())"
    />
  </UApp>
</template>
