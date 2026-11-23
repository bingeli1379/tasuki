<script setup lang="ts">
import type { OptionField } from '../option-values'

// The fields of a plugin's own form (D111). A secret already saved is never sent back; it
// shows as set, and left blank it is kept (D106).
const values = defineModel<Record<string, string>>({ required: true })
defineProps<{
  fields: OptionField[]
  // Choices a lookup brought for the select fields, over the field's own.
  choices?: Record<string, { value: string; label: string }[]>
  isSet: (key: string) => boolean
  lookup?: boolean
}>()
</script>

<template>
  <UFormField
    v-for="f in fields"
    :key="f.key"
    :label="f.label"
    :description="f.description ?? ''"
    :required="f.required === true"
  >
    <USelect
      v-if="f.type === 'select'"
      :model-value="values[f.key] ?? ''"
      :items="choices?.[f.key] ?? f.choices ?? []"
      :placeholder="lookup ? 'Look up first' : ''"
      class="w-full"
      @update:model-value="(v) => (values[f.key] = String(v))"
    />
    <UTextarea
      v-else-if="f.type === 'textarea' || f.type === 'list' || f.type === 'json'"
      :model-value="values[f.key] ?? ''"
      :placeholder="f.placeholder ?? (f.type === 'json' ? '{ }' : '')"
      :rows="f.type === 'textarea' ? 4 : 3"
      autoresize
      :class="['w-full', f.type === 'textarea' ? '' : 'font-mono']"
      @update:model-value="(v) => (values[f.key] = String(v))"
    />
    <UInput
      v-else
      :model-value="values[f.key] ?? ''"
      :type="f.type === 'secret' ? 'password' : 'text'"
      :placeholder="
        f.type === 'secret' && isSet(f.key) ? 'Set; leave blank to keep it' : (f.placeholder ?? '')
      "
      autocomplete="off"
      class="w-full"
      @update:model-value="(v) => (values[f.key] = String(v))"
    />
  </UFormField>
</template>
