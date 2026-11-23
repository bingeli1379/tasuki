<script setup lang="ts">
import { computed, ref } from 'vue'
import { call, messageOf, sendJson, type Account, type AuthState } from '../api'
import ApiTokens from './ApiTokens.vue'

const props = defineProps<{ me: Account; mode: AuthState['mode'] }>()

const tokensOpen = ref(false)
const passwordOpen = ref(false)
const current = ref('')
const next = ref('')
const again = ref('')
const mismatch = computed(() => again.value !== '' && again.value !== next.value)
const passwordError = ref('')
const toast = useToast()

const keepsAccounts = computed(() => props.mode === 'builtin')
const items = computed(() => [
  [{ label: props.me.displayName, type: 'label' as const }],
  [
    ...(keepsAccounts.value ? [{ label: 'Change password', onSelect: () => openPassword() }] : []),
    { label: 'API tokens', onSelect: () => (tokensOpen.value = true) },
  ],
  [{ label: 'Sign out', onSelect: () => void signOut() }],
])

function openPassword(): void {
  current.value = ''
  next.value = ''
  again.value = ''
  passwordError.value = ''
  passwordOpen.value = true
}

async function changePassword(): Promise<void> {
  try {
    await call('/api/me/password', sendJson('PUT', { current: current.value, next: next.value }))
    passwordOpen.value = false
    toast.add({ title: 'Password changed', color: 'success' })
  } catch (e) {
    passwordError.value = messageOf(e)
  }
}

async function signOut(): Promise<void> {
  await call('/api/auth/logout', { method: 'POST' })
  location.reload()
}
</script>

<template>
  <UDropdownMenu :items="items" :content="{ align: 'start' }">
    <UButton color="neutral" variant="ghost" aria-label="Account">
      <UIcon name="i-lucide-circle-user" class="size-5 sm:hidden" />
      <span class="hidden sm:inline">{{ me.displayName }}</span>
      <UIcon name="i-lucide-chevron-down" class="hidden size-5 sm:inline" />
    </UButton>
  </UDropdownMenu>
  <ApiTokens v-model:open="tokensOpen" />
  <UModal v-model:open="passwordOpen" title="Change password">
    <template #body>
      <form class="flex flex-col gap-4" @submit.prevent="changePassword">
        <UFormField label="Current password" required>
          <UInput
            v-model="current"
            type="password"
            autocomplete="current-password"
            required
            autofocus
            class="w-full"
          />
        </UFormField>
        <UFormField label="New password" hint="At least 8 characters" required>
          <UInput
            v-model="next"
            type="password"
            autocomplete="new-password"
            required
            class="w-full"
          />
        </UFormField>
        <UFormField
          label="Confirm new password"
          required
          :error="mismatch ? 'Passwords do not match' : false"
        >
          <UInput
            v-model="again"
            type="password"
            autocomplete="new-password"
            required
            class="w-full"
          />
        </UFormField>
        <UAlert v-if="passwordError" color="error" variant="subtle" :title="passwordError" />
        <UButton
          type="submit"
          label="Change password"
          :disabled="next === '' || again !== next"
          class="self-end"
        />
      </form>
    </template>
  </UModal>
</template>
