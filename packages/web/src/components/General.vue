<script setup lang="ts">
import { ref, watch } from 'vue'
import { ApiError, call, messageOf, sendJson } from '../api'

// What the instance runs on, for an admin (D105). Saved, the engine follows it at once.
const open = defineModel<boolean>('open', { required: true })

interface InstanceResponse {
  version?: number
  instance: {
    poll: { intervalSeconds: number }
    limits: Record<LimitKey, number>
  }
}

type LimitKey =
  | 'maxConcurrentRuns'
  | 'leaseSeconds'
  | 'defaultMaxAttempts'
  | 'softGraceSeconds'
  | 'hardGraceSeconds'

const LIMITS: { key: LimitKey; label: string; description: string }[] = [
  {
    key: 'maxConcurrentRuns',
    label: 'Agents at once',
    description: 'How many Runs go at the same time.',
  },
  {
    key: 'defaultMaxAttempts',
    label: 'Attempts',
    description: 'Tries per item for a rule that sets none.',
  },
  {
    key: 'leaseSeconds',
    label: 'Lease (seconds)',
    description: 'A Run nobody renews for this long is given up and its item goes back.',
  },
  {
    key: 'softGraceSeconds',
    label: 'Soft stop grace (seconds)',
    description: 'How long an agent asked to wrap up gets before it is stopped hard.',
  },
  {
    key: 'hardGraceSeconds',
    label: 'Hard stop grace (seconds)',
    description: 'How long a stopped agent gets before it is killed.',
  },
]

const loaded = ref<InstanceResponse>()
const poll = ref<number | null>(null)
const limits = ref<Record<LimitKey, number | null>>({
  maxConcurrentRuns: null,
  leaseSeconds: null,
  defaultMaxAttempts: null,
  softGraceSeconds: null,
  hardGraceSeconds: null,
})
const error = ref('')
const saving = ref(false)
const toast = useToast()

async function load(): Promise<void> {
  try {
    const res = await call<InstanceResponse>('/api/instance')
    loaded.value = res
    poll.value = res.instance.poll.intervalSeconds
    limits.value = { ...res.instance.limits }
    error.value = ''
  } catch (e) {
    error.value = messageOf(e)
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return
  loaded.value = undefined
  error.value = ''
  void load()
})

async function save(): Promise<void> {
  saving.value = true
  try {
    const version = loaded.value?.version
    const instance = {
      poll: { intervalSeconds: poll.value },
      limits: limits.value,
    }
    await call(
      '/api/instance',
      sendJson('PUT', { ...(version === undefined ? {} : { version }), instance }),
    )
    toast.add({ title: 'Saved: the engine follows it at once', color: 'success' })
    open.value = false
  } catch (e) {
    if (e instanceof ApiError && e.status === 409)
      toast.add({
        title: 'Someone else saved these settings meanwhile',
        description: 'Reload to see theirs; what you changed here is not kept.',
        color: 'error',
        actions: [{ label: 'Reload', onClick: () => void load() }],
      })
    else toast.add({ title: messageOf(e), color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="General"
    description="What the engine runs on. Saved, it follows them at once."
    :ui="{ content: 'sm:max-w-2xl', description: 'pe-8' }"
  >
    <template #body>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      <p v-else-if="!loaded" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        Loading the settings…
      </p>
      <form v-else class="grid gap-4 sm:grid-cols-2" @submit.prevent="save">
        <UFormField
          label="Poll every (seconds)"
          description="How often the engine looks at the tracker."
        >
          <UInputNumber v-model="poll" :min="1" class="w-full" />
        </UFormField>
        <UFormField v-for="l in LIMITS" :key="l.key" :label="l.label" :description="l.description">
          <UInputNumber v-model="limits[l.key]" :min="1" class="w-full" />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <span class="ms-auto flex gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton label="Save" :loading="saving" :disabled="!loaded" @click="save" />
      </span>
    </template>
  </UModal>
</template>
