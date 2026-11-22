<script setup lang="ts">
import { computed, ref } from 'vue'
import { call, messageOf, sendJson, type Account, type AuthState } from '../api'

const props = defineProps<{ state: AuthState }>()
const emit = defineEmits<{ signedIn: [me: Account] }>()

const username = ref('')
const password = ref('')
const again = ref('')
const token = ref('')
const error = ref('')
const busy = ref(false)
// Signed in through the outside system while there is no admin yet: the setup token raises them.
const signedInAs = ref<Account>()

// With the accounts in tasuki, the first admin is a new account made with the setup token;
// with them elsewhere, the person signs in first and then uses it.
const creatingFirst = computed(() => props.state.needsSetup && props.state.mode === 'builtin')

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
    if (props.state.needsSetup) signedInAs.value = me
    else emit('signedIn', me)
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}

async function raise(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const { me } = await call<{ me: Account }>(
      '/api/auth/setup',
      sendJson('POST', { token: token.value }),
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
      </template>

      <form v-if="signedInAs" class="flex flex-col gap-4" @submit.prevent="raise">
        <p class="text-sm">
          Signed in as {{ signedInAs.displayName }}. Enter the setup token to become the first
          admin.
        </p>
        <UFormField label="Setup token" required>
          <UInput v-model="token" required autofocus class="w-full" />
        </UFormField>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <UButton type="submit" label="Become admin" :loading="busy" block />
      </form>

      <form v-else class="flex flex-col gap-4" @submit.prevent="submit">
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
        <UFormField label="Password" required :hint="creatingFirst ? 'At least 8 characters' : ''">
          <UInput
            v-model="password"
            type="password"
            required
            :autocomplete="creatingFirst ? 'new-password' : 'current-password'"
            class="w-full"
          />
        </UFormField>
        <UFormField
          v-if="creatingFirst"
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
          :label="creatingFirst ? 'Create the first admin' : 'Sign in'"
          :loading="busy"
          :disabled="creatingFirst && again !== password"
          block
        />
      </form>
    </UCard>
  </div>
</template>
