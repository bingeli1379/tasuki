<script setup lang="ts">
import { ref, watch } from 'vue'
import { call, messageOf, sendJson, type ApiToken } from '../api'

const open = defineModel<boolean>('open', { required: true })

const tokens = ref<ApiToken[]>([])
const name = ref('')
const expiresOn = ref('')
// Shown once, right after it is made: only its hash is kept.
const made = ref<{ name: string; token: string }>()
const error = ref('')
const toast = useToast()
const busy = ref(false)
const copied = ref(false)

async function copy(): Promise<void> {
  if (!made.value) return
  try {
    await navigator.clipboard.writeText(made.value.token)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch (e) {
    error.value = messageOf(e)
  }
}

async function load(): Promise<void> {
  try {
    tokens.value = await call<ApiToken[]>('/api/tokens')
    error.value = ''
  } catch (e) {
    error.value = messageOf(e)
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return
  made.value = undefined
  name.value = ''
  expiresOn.value = ''
  void load()
})

async function create(): Promise<void> {
  busy.value = true
  try {
    const created = await call<ApiToken & { token: string }>(
      '/api/tokens',
      sendJson('POST', {
        name: name.value,
        // The end of that day, where the person is.
        ...(expiresOn.value === ''
          ? {}
          : { expiresAt: new Date(`${expiresOn.value}T23:59:59`).toISOString() }),
      }),
    )
    made.value = { name: created.name, token: created.token }
    name.value = ''
    expiresOn.value = ''
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}

async function revoke(token: ApiToken): Promise<void> {
  try {
    await call(`/api/tokens/${token.id}`, { method: 'DELETE' })
    await load()
  } catch (e) {
    toast.add({ title: messageOf(e), color: 'error' })
  }
}

const day = (iso: string): string => new Date(iso).toLocaleDateString()
</script>

<template>
  <UModal
    v-model:open="open"
    title="API tokens"
    description="For your own AI client on /mcp, such as Claude Code. It acts as you."
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UAlert
          v-if="made"
          color="success"
          variant="subtle"
          :title="`Copy ${made.name} now: it is not shown again.`"
        >
          <template #description>
            <span class="flex items-center gap-2">
              <code class="block min-w-0 flex-1 break-all select-all">{{ made.token }}</code>
              <UButton
                :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
                :aria-label="copied ? 'Copied' : 'Copy token'"
                color="success"
                variant="ghost"
                size="sm"
                @click="copy"
              />
            </span>
          </template>
        </UAlert>
        <form class="flex items-end gap-2" @submit.prevent="create">
          <UFormField label="Name" class="flex-1">
            <UInput v-model="name" placeholder="Claude Code on my laptop" class="w-full" />
          </UFormField>
          <UFormField label="Expires" hint="Optional">
            <UInput v-model="expiresOn" type="date" />
          </UFormField>
          <UButton type="submit" label="Create" :loading="busy" :disabled="name.trim() === ''" />
        </form>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <p v-if="tokens.length === 0" class="text-sm text-muted">No tokens yet.</p>
        <ul v-else class="divide-y divide-default">
          <li v-for="t in tokens" :key="t.id" class="flex items-center justify-between py-2">
            <span>
              <span class="font-medium">{{ t.name }}</span>
              <span class="ml-2 text-xs text-muted">
                made {{ day(t.createdAt) }}{{ t.expiresAt ? `, expires ${day(t.expiresAt)}` : '' }}
              </span>
            </span>
            <UButton
              label="Revoke"
              color="error"
              variant="ghost"
              size="sm"
              :aria-label="`Revoke ${t.name}`"
              @click="revoke(t)"
            />
          </li>
        </ul>
      </div>
    </template>
  </UModal>
</template>
