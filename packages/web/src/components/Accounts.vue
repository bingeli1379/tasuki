<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
const query = ref('')
const deleting = ref<Account>()
// Pasted from a list, one username per line.
const pasted = ref('')
const pastedAccess = ref<Access>('member')
const toast = useToast()
const failed = (e: unknown): void => void toast.add({ title: messageOf(e), color: 'error' })

const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q === ''
    ? accounts.value
    : accounts.value.filter(
        (a) => a.username.toLowerCase().includes(q) || a.displayName.toLowerCase().includes(q),
      )
})

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
    failed(e)
  }
}

async function addPasted(): Promise<void> {
  try {
    const result = await call<{ existing: string[] }>(
      '/api/accounts/batch',
      sendJson('POST', { usernames: pasted.value.split(/\r?\n/), access: pastedAccess.value }),
    )
    if (result.existing.length > 0)
      toast.add({ title: `Already here, left as they were: ${result.existing.join(', ')}` })
    pasted.value = ''
    adding.value = false
    await load()
  } catch (e) {
    failed(e)
  }
}

async function remove(): Promise<void> {
  const account = deleting.value
  if (!account) return
  try {
    await call(`/api/accounts/${account.userId}`, { method: 'DELETE' })
    deleting.value = undefined
    await load()
  } catch (e) {
    failed(e)
  }
}

async function change(account: Account, change: { access?: Access; disabled?: boolean }) {
  try {
    await call(`/api/accounts/${account.userId}`, sendJson('PATCH', change))
    await load()
  } catch (e) {
    failed(e)
    await load()
  }
}

// One form open at a time: two stacked forms read as one.
function startReset(account: Account): void {
  adding.value = false
  deleting.value = undefined
  resetting.value = account
  newPassword.value = ''
  resetAgain.value = ''
}

function startAdding(): void {
  resetting.value = undefined
  deleting.value = undefined
  adding.value = true
}

function startDelete(account: Account): void {
  adding.value = false
  resetting.value = undefined
  deleting.value = account
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
  } catch (e) {
    failed(e)
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
        : 'Only people added here sign in, with their company account.'
    "
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <UFormField label="Find someone" :ui="{ label: 'sr-only' }">
          <UInput
            v-model="query"
            icon="i-lucide-search"
            placeholder="Find someone"
            class="w-full"
          />
        </UFormField>
        <ul class="divide-y divide-default">
          <li v-for="a in shown" :key="a.userId" :aria-label="a.username" class="py-2">
            <div class="flex items-center justify-between gap-3">
              <span :class="{ 'opacity-50': a.disabled }">
                <span class="font-medium">{{ a.displayName }}</span>
                <!-- Accounts from an outside system can carry a name apart from the username. -->
                <span v-if="a.displayName !== a.username" class="ml-2 text-xs text-muted">
                  {{ a.username }}
                </span>
                <UBadge v-if="a.disabled" label="Disabled" color="neutral" size="sm" class="ml-2" />
                <UBadge
                  v-else-if="!keepsAccounts && a.externalId === undefined"
                  label="Not signed in yet"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  class="ml-2"
                />
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
                <UTooltip text="Delete" :delay-duration="100">
                  <UButton
                    icon="i-lucide-trash-2"
                    :aria-label="`Delete ${a.username}`"
                    color="error"
                    variant="ghost"
                    size="sm"
                    :disabled="a.userId === props.me.userId"
                    @click="startDelete(a)"
                  />
                </UTooltip>
              </span>
            </div>
            <!-- Under the account it is for, where the button was pressed however far down. -->
            <div
              v-if="deleting?.userId === a.userId"
              class="mt-2 flex items-center justify-between gap-3 rounded-lg bg-elevated p-3"
            >
              <p class="text-sm">
                {{
                  keepsAccounts
                    ? 'Their sessions and API tokens stop working.'
                    : 'They cannot sign in until someone adds them again.'
                }}
                What they wrote keeps their name.
              </p>
              <span class="flex shrink-0 gap-2">
                <UButton
                  label="Keep"
                  color="neutral"
                  variant="ghost"
                  @click="deleting = undefined"
                />
                <UButton label="Delete for good" color="error" @click="remove" />
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
        <template v-if="!keepsAccounts">
          <form
            v-if="adding"
            class="flex flex-col gap-3 rounded-lg border border-default p-4"
            @submit.prevent="addPasted"
          >
            <h3 class="font-semibold">Add people</h3>
            <UFormField label="Usernames" hint="One per line, as they sign in to the company">
              <UTextarea v-model="pasted" :rows="5" autoresize autofocus class="w-full" />
            </UFormField>
            <UFormField label="Access">
              <USelect v-model="pastedAccess" :items="ACCESS" class="w-full" />
            </UFormField>
            <span class="flex justify-end gap-2">
              <UButton label="Cancel" color="neutral" variant="ghost" @click="adding = false" />
              <UButton type="submit" label="Add people" :disabled="pasted.trim() === ''" />
            </span>
          </form>
          <UButton
            v-else
            label="Add people"
            variant="outline"
            class="self-start"
            @click="startAdding"
          />
        </template>
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
