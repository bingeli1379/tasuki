<script setup lang="ts">
import { computed, ref } from 'vue'
import { call, messageOf, sendJson, type Account, type AuthState } from '../api'

const props = defineProps<{ state: AuthState }>()
const emit = defineEmits<{ signedIn: [me: Account] }>()

const username = ref('')
const password = ref('')
const again = ref('')
// The start-up log prints a link carrying the token; it leaves the address bar at once.
const token = ref(new URLSearchParams(location.search).get('setup') ?? '')
if (token.value !== '') history.replaceState(null, '', location.pathname)
const error = ref('')
const busy = ref(false)

// The first admin, with the setup token: a new account when tasuki keeps them, or the person
// whose company password the outside system accepts (D90).
const creatingFirst = computed(() => props.state.needsSetup)
const newPassword = computed(() => creatingFirst.value && props.state.mode === 'builtin')

async function submit(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    if (creatingFirst.value) {
      const { me } = await call<{ me: Account }>(
        '/api/auth/setup',
        sendJson('POST', {
          token: token.value,
          username: username.value,
          password: password.value,
        }),
      )
      emit('signedIn', me)
      return
    }
    const { me } = await call<{ me: Account }>(
      '/api/auth/login',
      sendJson('POST', { username: username.value, password: password.value }),
    )
    emit('signedIn', me)
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-muted p-6">
    <UCard class="w-full max-w-sm">
      <template #header>
        <h1
          class="flex items-center gap-3 text-2xl font-extrabold tracking-tight text-highlighted"
          style="font-stretch: 78%"
        >
          <span aria-hidden="true" class="block h-6 w-2.5 -skew-x-[28deg] rounded-[3px] bg-sash" />
          Tasuki
        </h1>
        <p v-if="state.needsSetup" class="mt-2 text-sm text-muted">
          There is no admin yet. The setup token is in the engine's start-up log and in the
          <code>setup-token</code> file in its data folder.
        </p>
        <p v-if="state.mode === 'external'" class="mt-2 text-sm text-muted">
          Sign in with your company account.
        </p>
      </template>

      <form class="flex flex-col gap-4" @submit.prevent="submit">
        <UFormField v-if="creatingFirst" label="Setup token" required>
          <UInput v-model="token" required autofocus class="w-full" />
        </UFormField>
        <UFormField label="Username" required>
          <UInput
            v-model="username"
            required
            autocomplete="username"
            :autofocus="!creatingFirst"
            class="w-full"
          />
        </UFormField>
        <UFormField label="Password" required :hint="newPassword ? 'At least 8 characters' : ''">
          <UInput
            v-model="password"
            type="password"
            required
            :autocomplete="newPassword ? 'new-password' : 'current-password'"
            class="w-full"
          />
        </UFormField>
        <UFormField
          v-if="newPassword"
          label="Confirm password"
          required
          :error="again !== '' && again !== password ? 'Passwords do not match' : false"
        >
          <UInput
            v-model="again"
            type="password"
            autocomplete="new-password"
            required
            class="w-full"
          />
        </UFormField>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <UButton
          type="submit"
          :label="
            !creatingFirst
              ? 'Sign in'
              : newPassword
                ? 'Create the first admin'
                : 'Become the first admin'
          "
          :loading="busy"
          :disabled="newPassword && again !== password"
          block
        />
      </form>
    </UCard>
  </div>
</template>
