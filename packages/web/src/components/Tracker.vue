<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ApiError, call, messageOf, sendJson } from '../api'
import { toOptions, toValues, type OptionField as Field } from '../option-values'
import OptionFields from './OptionFields.vue'

// Which tracker the engine runs on, for an admin (D105). The form is the plugin's own; a
// secret is never sent back, only whether it is set (D106).
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()

interface TrackerView {
  version?: number
  plugin: string
  options: Record<string, unknown>
  secretsSet: string[]
  fields: Field[]
  lookup: boolean
}

const BUILT_IN = [
  { label: 'sqlite, kept by tasuki', value: '@tasuki/sqlite' },
  { label: 'Jira Cloud', value: '@tasuki/jira-cloud' },
]
const OTHER = '_other'

const loaded = ref<TrackerView>()
const kind = ref('')
const otherPlugin = ref('')
const fields = ref<Field[]>([])
const lookup = ref(false)
const values = ref<Record<string, string>>({})
const choices = ref<Record<string, { value: string; label: string }[]>>({})
const error = ref('')
const looking = ref(false)
const saving = ref(false)
const toast = useToast()

const plugin = computed(() => (kind.value === OTHER ? otherPlugin.value.trim() : kind.value))
const switched = computed(() => loaded.value !== undefined && plugin.value !== loaded.value.plugin)
const isSet = (key: string) => !switched.value && (loaded.value?.secretsSet.includes(key) ?? false)

function fill(view: { fields: Field[]; lookup: boolean }, options: Record<string, unknown>): void {
  fields.value = view.fields
  lookup.value = view.lookup
  values.value = toValues(view.fields, options)
  // What is saved shows as a choice of its own until a lookup brings the real list.
  choices.value = Object.fromEntries(
    view.fields
      .filter((f) => f.type === 'select' && f.choices === undefined && values.value[f.key] !== '')
      .map((f) => [
        f.key,
        [{ value: values.value[f.key] ?? '', label: values.value[f.key] ?? '' }],
      ]),
  )
}

async function load(): Promise<void> {
  try {
    const res = await call<TrackerView>('/api/tracker')
    loaded.value = res
    const builtIn = BUILT_IN.some((b) => b.value === res.plugin)
    kind.value = builtIn ? res.plugin : OTHER
    otherPlugin.value = builtIn ? '' : res.plugin
    fill(res, res.options)
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

// Another plugin brings another form; back to the one in use brings back what is saved.
async function pickPlugin(): Promise<void> {
  if (!loaded.value || plugin.value === '') return
  if (!switched.value) return fill(loaded.value, loaded.value.options)
  try {
    fill(
      await call<{ fields: Field[]; lookup: boolean }>(
        `/api/tracker/form?plugin=${encodeURIComponent(plugin.value)}`,
      ),
      {},
    )
  } catch (e) {
    toast.add({ title: messageOf(e), color: 'error' })
  }
}

async function lookUp(): Promise<void> {
  looking.value = true
  try {
    choices.value = await call(
      '/api/tracker/choices',
      sendJson('POST', {
        plugin: plugin.value,
        options: toOptions(fields.value, values.value, switched.value ? {} : loaded.value?.options),
      }),
    )
  } catch (e) {
    toast.add({ title: messageOf(e), color: 'error' })
  } finally {
    looking.value = false
  }
}

async function save(): Promise<void> {
  saving.value = true
  try {
    const version = loaded.value?.version
    await call(
      '/api/tracker',
      sendJson('PUT', {
        ...(version === undefined ? {} : { version }),
        plugin: plugin.value,
        options: toOptions(fields.value, values.value, switched.value ? {} : loaded.value?.options),
      }),
    )
    toast.add({ title: 'Saved: the engine runs on it now', color: 'success' })
    open.value = false
    emit('saved')
  } catch (e) {
    if (e instanceof ApiError && e.status === 409)
      toast.add({
        title: 'Someone else saved the tracker meanwhile',
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
    title="Tracker"
    description="Where the items live. Changing it needs an empty board and no agent running."
    :ui="{ content: 'sm:max-w-2xl', description: 'pe-8' }"
  >
    <template #body>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      <p v-else-if="!loaded" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        Loading the tracker…
      </p>
      <form v-else class="flex flex-col gap-4" @submit.prevent="save">
        <UFormField label="Tracker">
          <USelect
            v-model="kind"
            :items="[...BUILT_IN, { label: 'Another plugin', value: OTHER }]"
            class="w-full"
            @update:model-value="pickPlugin"
          />
        </UFormField>
        <UFormField v-if="kind === OTHER" label="Package name">
          <UInput
            v-model="otherPlugin"
            placeholder="@acme/tasuki-linear"
            class="w-full"
            @change="pickPlugin"
          />
        </UFormField>
        <OptionFields
          v-model="values"
          :fields="fields"
          :choices="choices"
          :is-set="isSet"
          :lookup="lookup"
        />
        <div v-if="lookup">
          <UButton
            label="Look up"
            icon="i-lucide-search"
            color="neutral"
            variant="outline"
            :loading="looking"
            @click="lookUp"
          />
        </div>
      </form>
    </template>
    <template #footer>
      <span class="ms-auto flex gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton
          label="Save"
          :loading="saving"
          :disabled="!loaded || plugin === ''"
          @click="save"
        />
      </span>
    </template>
  </UModal>
</template>
