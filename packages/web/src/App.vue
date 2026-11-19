<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Item {
  ref: string
  title: string
  body: string
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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const data: unknown = await res.json()
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
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

      <main class="flex-1 p-6">
        <UAlert v-if="error" color="error" variant="subtle" :title="error" class="mb-4" />

        <div class="flex items-start gap-4 overflow-x-auto pb-4">
          <section
            v-for="column in columns"
            :key="column.status"
            :aria-labelledby="`column-${column.status}`"
            class="flex w-72 shrink-0 flex-col gap-2 rounded-lg bg-elevated p-3"
          >
            <h2
              :id="`column-${column.status}`"
              class="flex items-center justify-between px-1 text-sm font-medium"
            >
              {{ column.displayName }}
              <UBadge :label="column.items.length" color="neutral" variant="subtle" size="sm" />
            </h2>
            <article v-for="item in column.items" :key="item.ref" :aria-label="item.title">
              <UCard :ui="{ body: 'p-3 sm:p-3' }">
                <p class="text-xs text-muted">{{ item.ref }}</p>
                <p class="font-medium">{{ item.title }}</p>
                <p v-if="item.body" class="mt-1 text-sm whitespace-pre-wrap text-toned">
                  {{ item.body }}
                </p>
              </UCard>
            </article>
          </section>
        </div>
      </main>
    </div>
  </UApp>
</template>
