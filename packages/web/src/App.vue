<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

interface Item {
  ref: string
  title: string
  body: string
  status: string
}
interface Column {
  status: string
  displayName: string
  items: Item[]
}

const columns = ref<Column[]>([])
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

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly data: { error?: string; item?: Item },
  ) {
    super(data.error ?? `HTTP ${status}`)
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const data: unknown = await res.json()
  if (!res.ok) throw new ApiError(res.status, data as { error?: string })
  return data as T
}

// Takes the card out of whichever column holds it and puts it in the one its status names.
function place(item: Item): void {
  for (const column of columns.value) column.items = column.items.filter((i) => i.ref !== item.ref)
  columns.value.find((c) => c.status === item.status)?.items.push(item)
}

async function load(): Promise<void> {
  try {
    columns.value = (await call<{ columns: Column[] }>('/api/board')).columns
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function create(): Promise<void> {
  saving.value = true
  try {
    const item = await call<Item & { status: string }>('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.value, body: body.value }),
    })
    // Not a reload: the board may lag behind writes (Jira search index).
    columns.value.find((c) => c.status === item.status)?.items.push(item)
    title.value = ''
    body.value = ''
    error.value = ''
    open.value = false
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
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
      await call<Item>(`/api/items/${item.ref}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: item.status, to }),
      }),
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
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    pending.value = pending.value.filter((r) => r !== item.ref)
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
        <UModal v-model:open="open" title="New item">
          <UButton label="New item" />
          <template #body>
            <form class="flex flex-col gap-4" @submit.prevent="create">
              <UFormField label="Title" required>
                <UInput v-model="title" required autofocus class="w-full" />
              </UFormField>
              <UFormField label="Body">
                <UTextarea v-model="body" :rows="4" autoresize class="w-full" />
              </UFormField>
              <UButton type="submit" label="Create" :loading="saving" class="self-end" />
            </form>
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
            <h2
              :id="`column-${column.status}`"
              class="flex items-center justify-between px-1 text-sm font-medium"
            >
              {{ column.displayName }}
              <UBadge :label="column.items.length" color="neutral" variant="subtle" size="sm" />
            </h2>
            <article
              v-for="item in column.items"
              :key="item.ref"
              :aria-label="item.title"
              :draggable="!pending.includes(item.ref)"
              :class="pending.includes(item.ref) ? 'opacity-60' : 'cursor-grab'"
              @dragstart="dragging = item"
              @dragend="((dragging = undefined), (over = undefined))"
            >
              <UCard :ui="{ body: 'p-3 sm:p-3' }">
                <div class="flex items-center justify-between">
                  <p class="text-xs text-muted">{{ item.ref }}</p>
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
                    />
                  </UDropdownMenu>
                </div>
                <p class="font-medium">{{ item.title }}</p>
                <p v-if="item.body" class="mt-1 text-sm whitespace-pre-wrap text-toned">
                  {{ item.body }}
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
  </UApp>
</template>
