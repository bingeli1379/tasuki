<script setup lang="ts">
import { ref, watch } from 'vue'
import { call, messageOf, sendJson, type Access, type Account } from '../api'

const props = defineProps<{ me: Account; keepsAccounts: boolean }>()
const open = defineModel<boolean>('open', { required: true })

const ACCESS: { value: Access; label: string; hint: string }[] = [
  { value: 'admin', label: 'Admin', hint: 'Manages accounts and settings' },
  { value: 'maintainer', label: 'Maintainer', hint: 'Changes settings' },
  { value: 'member', label: 'Member', hint: 'Uses the board' },
]

const accounts = ref<Account[]>([])
const error = ref('')
const adding = ref(false)
const draft = ref({ username: '', password: '', access: 'member' as Access })
const draftAgain = ref('')
const resetAgain = ref('')
const resetting = ref<Account>()
const newPassword = ref('')

async function load(): Promise<void> {
  try {
    accounts.value = await call<Account[]>('/api/accounts')
    error.value = ''
  } catch (e) {
    error.value = messageOf(e)
  }
}

watch(open, (isOpen) => {
  if (isOpen) void load()
})

async function create(): Promise<void> {
  try {
    await call('/api/accounts', sendJson('POST', draft.value))
    draft.value = { username: '', password: '', access: 'member' }
    draftAgain.value = ''
    adding.value = false
    await load()
  } catch (e) {
    error.value = messageOf(e)
  }
}

async function change(account: Account, change: { access?: Access; disabled?: boolean }) {
  try {
    await call(`/api/accounts/${account.userId}`, sendJson('PATCH', change))
    await load()
  } catch (e) {
    error.value = messageOf(e)
    await load()
  }
}

// One form open at a time: two stacked forms read as one.
function startReset(account: Account): void {
  adding.value = false
  resetting.value = account
  newPassword.value = ''
  resetAgain.value = ''
}

function startAdding(): void {
  resetting.value = undefined
  adding.value = true
}

async function reset(): Promise<void> {
  const account = resetting.value
  if (!account) return
  try {
    await call(
      `/api/accounts/${account.userId}/password`,
      sendJson('PUT', { password: newPassword.value }),
    )
    resetting.value = undefined
    newPassword.value = ''
    resetAgain.value = ''
    error.value = ''
  } catch (e) {
    error.value = messageOf(e)
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Accounts"
    :description="
      keepsAccounts
        ? 'Everyone who can sign in, and what they may do.'
        : 'Accounts come from the outside system; someone signing in for the first time is a member.'
    "
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <ul class="divide-y divide-default">
          <li v-for="a in accounts" :key="a.userId" :aria-label="a.username" class="py-2">
            <div class="flex items-center justify-between gap-3">
              <span :class="{ 'opacity-50': a.disabled }">
                <span class="font-medium">{{ a.displayName }}</span>
                <!-- Accounts from an outside system can carry a name apart from the username. -->
                <span v-if="a.displayName !== a.username" class="ml-2 text-xs text-muted">
                  {{ a.username }}
                </span>
                <UBadge v-if="a.disabled" label="Disabled" color="neutral" size="sm" class="ml-2" />
              </span>
              <span class="flex items-center gap-1">
                <USelect
                  :model-value="a.access"
                  :items="ACCESS"
                  size="sm"
                  class="w-36"
                  @update:model-value="(v) => change(a, { access: v as Access })"
                />
                <UTooltip v-if="keepsAccounts" text="Reset password" :delay-duration="100">
                  <UButton
                    icon="i-lucide-key-round"
                    :aria-label="`Reset the password of ${a.username}`"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    @click="startReset(a)"
                  />
                </UTooltip>
                <UTooltip :text="a.disabled ? 'Enable' : 'Disable'" :delay-duration="100">
                  <UButton
                    :icon="a.disabled ? 'i-lucide-user-check' : 'i-lucide-user-x'"
                    :aria-label="`${a.disabled ? 'Enable' : 'Disable'} ${a.username}`"
                    :color="a.disabled ? 'neutral' : 'error'"
                    variant="ghost"
                    size="sm"
                    :disabled="a.userId === props.me.userId"
                    @click="change(a, { disabled: !a.disabled })"
                  />
                </UTooltip>
              </span>
            </div>
            <!-- Under the account it is for, so it is clear whose password changes. -->
            <form
              v-if="resetting?.userId === a.userId"
              class="mt-2 flex items-start gap-2 rounded-lg bg-elevated p-3"
              @submit.prevent="reset"
            >
              <UFormField label="New password" :ui="{ label: 'sr-only' }" class="flex-1">
                <UInput
                  v-model="newPassword"
                  type="password"
                  autocomplete="new-password"
                  placeholder="New password"
                  autofocus
                  class="w-full"
                />
              </UFormField>
              <UFormField
                label="Confirm new password"
                :ui="{ label: 'sr-only' }"
                class="flex-1"
                :error="
                  resetAgain !== '' && resetAgain !== newPassword ? 'Passwords do not match' : false
                "
              >
                <UInput
                  v-model="resetAgain"
                  type="password"
                  autocomplete="new-password"
                  placeholder="Confirm"
                  class="w-full"
                />
              </UFormField>
              <UButton
                type="submit"
                label="Set"
                :disabled="newPassword === '' || resetAgain !== newPassword"
              />
              <UButton
                label="Cancel"
                color="neutral"
                variant="ghost"
                @click="resetting = undefined"
              />
            </form>
          </li>
        </ul>
        <template v-if="keepsAccounts">
          <form
            v-if="adding"
            class="grid grid-cols-2 gap-3 rounded-lg border border-default p-4"
            @submit.prevent="create"
          >
            <h3 class="col-span-2 font-semibold">New account</h3>
            <UFormField label="Username" required>
              <UInput v-model="draft.username" required autofocus class="w-full" />
            </UFormField>
            <UFormField label="Access">
              <USelect v-model="draft.access" :items="ACCESS" class="w-full" />
            </UFormField>
            <UFormField label="Password" hint="At least 8 characters" required>
              <UInput
                v-model="draft.password"
                type="password"
                autocomplete="new-password"
                required
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Confirm password"
              required
              :error="
                draftAgain !== '' && draftAgain !== draft.password
                  ? 'Passwords do not match'
                  : false
              "
            >
              <UInput
                v-model="draftAgain"
                type="password"
                autocomplete="new-password"
                required
                class="w-full"
              />
            </UFormField>
            <span class="col-span-2 flex justify-end gap-2">
              <UButton label="Cancel" color="neutral" variant="ghost" @click="adding = false" />
              <UButton
                type="submit"
                label="Add account"
                :disabled="draft.password === '' || draftAgain !== draft.password"
              />
            </span>
          </form>
          <UButton
            v-else
            label="Add account"
            variant="outline"
            class="self-start"
            @click="startAdding"
          />
        </template>
      </div>
    </template>
  </UModal>
</template>
