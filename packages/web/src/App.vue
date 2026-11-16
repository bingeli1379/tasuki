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
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <main>
    <h1>Tasuki</h1>

    <form class="new-item" @submit.prevent="create">
      <input v-model="title" placeholder="Title" required />
      <textarea v-model="body" placeholder="Body" rows="3" />
      <button type="submit" :disabled="saving">{{ saving ? 'Creating…' : 'New item' }}</button>
    </form>

    <p v-if="error" class="error">{{ error }}</p>

    <section class="board">
      <div v-for="column in columns" :key="column.status" class="column">
        <h2>{{ column.displayName }} ({{ column.items.length }})</h2>
        <article v-for="item in column.items" :key="item.ref" class="card">
          <small>{{ item.ref }}</small>
          <strong>{{ item.title }}</strong>
          <p v-if="item.body">{{ item.body }}</p>
        </article>
      </div>
    </section>
  </main>
</template>

<style scoped>
main {
  font-family: system-ui, sans-serif;
  padding: 16px;
}
.new-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 480px;
  margin-bottom: 16px;
}
.error {
  color: #b00020;
}
.board {
  display: flex;
  gap: 12px;
  overflow-x: auto;
}
.column {
  flex: 0 0 240px;
  background: #f4f5f7;
  border-radius: 6px;
  padding: 8px;
}
.column h2 {
  font-size: 14px;
  margin: 4px 0 8px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: #fff;
  border-radius: 4px;
  padding: 8px;
  margin-bottom: 8px;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.15);
}
.card p {
  margin: 0;
  white-space: pre-wrap;
}
</style>
