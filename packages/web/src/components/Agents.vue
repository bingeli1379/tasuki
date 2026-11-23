<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ApiError, call, messageOf, sendJson } from '../api'
import { toOptions, toValues, type OptionField } from '../option-values'
import OptionFields from './OptionFields.vue'

// The agents rules pick from, for an admin (D107). Each form is its runner plugin's own; a
// secret is never sent back, only whether it is set (D106). Saved, the next Run uses it.
const open = defineModel<boolean>('open', { required: true })

interface AgentView {
  name: string
  plugin: string
  options: Record<string, unknown>
  secretsSet: string[]
  fields: OptionField[]
}

interface Finding {
  level: 'error' | 'warning'
  where: string
  message: string
  fix?: string
}

interface Agent {
  name: string
  // What is saved under this name, unset for one added here.
  saved?: AgentView
  kind: string
  otherPlugin: string
  fields: OptionField[]
  values: Record<string, string>
}

const BUILT_IN = [
  { label: 'claude', value: '@tasuki/claude-cli' },
  { label: 'codex', value: '@tasuki/codex-cli' },
]
const OTHER = '_other'

const version = ref<number>()
const agents = ref<Agent[]>([])
const picked = ref('')
const findings = ref<Finding[]>()
const error = ref('')
const loaded = ref(false)
const saving = ref(false)
const adding = ref(false)
const newName = ref('')
const newKind = ref(BUILT_IN[0]?.value ?? '')
const toast = useToast()

const pluginOf = (a: Agent): string => (a.kind === OTHER ? a.otherPlugin.trim() : a.kind)
const current = computed(() => agents.value.find((a) => a.name === picked.value))
const isSet = (key: string): boolean => {
  const a = current.value
  return (
    a?.saved !== undefined && pluginOf(a) === a.saved.plugin && a.saved.secretsSet.includes(key)
  )
}
const findingsOf = (name: string): Finding[] =>
  (findings.value ?? []).filter((f) => f.where === `agent ${name}`)
const kindOf = (plugin: string): string =>
  BUILT_IN.some((b) => b.value === plugin) ? plugin : OTHER

async function check(): Promise<void> {
  findings.value = undefined
  try {
    findings.value = await call<Finding[]>('/api/agents/check')
  } catch (e) {
    findings.value = [{ level: 'error', where: `agent ${picked.value}`, message: messageOf(e) }]
  }
}

async function load(): Promise<void> {
  try {
    const res = await call<{ version?: number; agents: AgentView[] }>('/api/agents')
    version.value = res.version
    agents.value = res.agents.map((a) => ({
      name: a.name,
      saved: a,
      kind: kindOf(a.plugin),
      otherPlugin: kindOf(a.plugin) === OTHER ? a.plugin : '',
      fields: a.fields,
      values: toValues(a.fields, a.options),
    }))
    if (!agents.value.some((a) => a.name === picked.value))
      picked.value = agents.value[0]?.name ?? ''
    loaded.value = true
    error.value = ''
    void check()
  } catch (e) {
    error.value = messageOf(e)
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return
  loaded.value = false
  error.value = ''
  void load()
})

// Another plugin brings another form; back to the saved one brings back what is saved.
async function pickPlugin(a: Agent): Promise<void> {
  const plugin = pluginOf(a)
  if (plugin === '') return
  if (a.saved !== undefined && plugin === a.saved.plugin) {
    a.fields = a.saved.fields
    a.values = toValues(a.fields, a.saved.options)
    return
  }
  try {
    const form = await call<{ fields: OptionField[] }>(
      `/api/agents/form?plugin=${encodeURIComponent(plugin)}`,
    )
    a.fields = form.fields
    a.values = toValues(form.fields, {})
  } catch (e) {
    toast.add({ title: messageOf(e), color: 'error' })
  }
}

async function add(): Promise<void> {
  const name = newName.value.trim()
  if (name === '') return
  if (agents.value.some((a) => a.name === name))
    return void toast.add({ title: `There is an agent ${name} already`, color: 'error' })
  const agent: Agent = { name, kind: newKind.value, otherPlugin: '', fields: [], values: {} }
  agents.value.push(agent)
  picked.value = name
  adding.value = false
  newName.value = ''
  await pickPlugin(agents.value.at(-1) ?? agent)
}

function remove(name: string): void {
  agents.value = agents.value.filter((a) => a.name !== name)
  picked.value = agents.value[0]?.name ?? ''
}

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  toast.add({ title: 'Copied', color: 'success' })
}

async function save(): Promise<void> {
  saving.value = true
  try {
    const body = Object.fromEntries(
      agents.value.map((a) => [
        a.name,
        { plugin: pluginOf(a), options: toOptions(a.fields, a.values) },
      ]),
    )
    await call(
      '/api/agents',
      sendJson('PUT', {
        ...(version.value === undefined ? {} : { version: version.value }),
        agents: body,
      }),
    )
    toast.add({ title: 'Saved: the next Run uses it', color: 'success' })
    await load()
  } catch (e) {
    if (e instanceof ApiError && e.status === 409)
      toast.add({
        title: 'Someone else saved the agents meanwhile',
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
    title="Agents"
    description="What rules run on. A rule picks one by name; a save applies from the next Run."
    :ui="{ content: 'sm:max-w-3xl', description: 'pe-8' }"
  >
    <template #body>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      <p v-else-if="!loaded" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        Loading the agents…
      </p>
      <div v-else class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            v-for="a in agents"
            :key="a.name"
            :label="a.name"
            :color="a.name === picked ? 'primary' : 'neutral'"
            :variant="a.name === picked ? 'solid' : 'outline'"
            size="sm"
            :icon="
              findingsOf(a.name).some((f) => f.level === 'error')
                ? 'i-lucide-circle-alert'
                : undefined
            "
            @click="picked = a.name"
          />
          <UButton
            v-if="!adding"
            label="Add agent"
            icon="i-lucide-plus"
            color="neutral"
            variant="ghost"
            size="sm"
            @click="adding = true"
          />
        </div>
        <form v-if="adding" class="flex flex-wrap items-end gap-2" @submit.prevent="add">
          <UFormField label="Name" description="Lowercase; a rule picks it by this, for good.">
            <UInput v-model="newName" placeholder="claude-review" autofocus />
          </UFormField>
          <UFormField label="Runs on">
            <USelect
              v-model="newKind"
              :items="[...BUILT_IN, { label: 'Another plugin', value: OTHER }]"
            />
          </UFormField>
          <UButton type="submit" label="Add" />
          <UButton label="Cancel" color="neutral" variant="ghost" @click="adding = false" />
        </form>
        <p v-if="agents.length === 0" class="text-sm text-muted">
          No agents: rules have nothing to run on.
        </p>
        <form v-if="current" class="flex flex-col gap-4" @submit.prevent="save">
          <p v-if="findings === undefined" class="flex items-center gap-2 text-sm text-muted">
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
            Checking {{ current.name }}…
          </p>
          <UAlert
            v-for="(f, i) in findingsOf(current.name)"
            :key="i"
            :color="f.level === 'error' ? 'error' : 'warning'"
            variant="subtle"
            :title="f.message"
          >
            <template v-if="f.fix" #description>
              <span class="flex items-center gap-2">
                <code class="font-mono text-xs">{{ f.fix }}</code>
                <UButton
                  icon="i-lucide-copy"
                  aria-label="Copy"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  @click="copy(f.fix)"
                />
              </span>
            </template>
          </UAlert>
          <UFormField label="Runs on">
            <USelect
              v-model="current.kind"
              :items="[...BUILT_IN, { label: 'Another plugin', value: OTHER }]"
              class="w-full"
              @update:model-value="pickPlugin(current)"
            />
          </UFormField>
          <UFormField v-if="current.kind === OTHER" label="Package name">
            <UInput
              v-model="current.otherPlugin"
              placeholder="@acme/tasuki-gemini"
              class="w-full"
              @change="pickPlugin(current)"
            />
          </UFormField>
          <OptionFields v-model="current.values" :fields="current.fields" :is-set="isSet" />
          <div>
            <UButton
              :label="`Remove ${current.name}`"
              icon="i-lucide-trash-2"
              color="error"
              variant="ghost"
              size="sm"
              @click="remove(current.name)"
            />
          </div>
        </form>
      </div>
    </template>
    <template #footer>
      <span class="ms-auto flex gap-2">
        <UButton label="Close" color="neutral" variant="ghost" @click="open = false" />
        <UButton label="Save" :loading="saving" :disabled="!loaded" @click="save" />
      </span>
    </template>
  </UModal>
</template>
