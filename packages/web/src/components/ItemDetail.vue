<script setup lang="ts">
import { TASK_STATUS_DISPLAY, type Roles } from '@tasuki/core'
import { computed, ref, useTemplateRef, watch } from 'vue'
import {
  ApiError,
  attachmentUrl,
  call,
  messageOf,
  sendJson,
  type Attachment,
  type Comment,
  type Item,
  type ItemDetail,
  type Run,
} from '../api'
import {
  AttachmentImage,
  EDITOR_PROPS,
  EDITOR_TOOLBAR,
  Embed,
  MARKDOWN_OPTIONS,
  toStoredMarkdown,
} from '../editor'
import { renderMarkdown } from '../markdown'
import { TASK_COLOR } from '../task-status'
import TaskDetail from './TaskDetail.vue'

const props = defineProps<{
  itemRef: string
  statusName: (status: string) => string
  holdLabel: string
  // The card as the board has it: shown at once, while the rest is read.
  initial?: Item | undefined
  // Changes whenever the board sees this item change (status, version, Run): read again.
  seen: string
  columns: { status: string; displayName: string; outcomes: string[] }[]
  roles: Roles
}>()
const emit = defineEmits<{ updated: [item: Item]; move: [to: string]; deleted: [ref: string] }>()
const open = defineModel<boolean>('open', { required: true })

const detail = ref<ItemDetail>()
const error = ref('')
const editing = ref(false)
const draftTitle = ref('')
const draftBody = ref('')
const saving = ref(false)
const commentDraft = ref('')
const commenting = ref(false)
const uploading = ref(false)
const moving = ref(false)
const controlling = ref(false)
const reworking = ref(false)
const reworkDraft = ref('')
const confirmingDelete = ref(false)
const openTask = ref<string>()
const taskOpen = computed({
  get: () => openTask.value !== undefined,
  set: (value) => {
    if (!value) openTask.value = undefined
  },
})
const toast = useToast()
const bodyEditor = useTemplateRef('bodyEditor')
const fileInput = useTemplateRef('fileInput')
// The image attachment shown full size.
const preview = ref<Attachment>()

// Passed to UEditor once: a new object on each render makes it rebuild the editor and
// register its plugins twice ("Adding different instances of a keyed plugin").
const extensions = [Embed, AttachmentImage.configure({ itemRef: props.itemRef })]
// On the editable element itself, not the wrapper: padding and height on the wrapper are
// blank space a click does not reach the editor through.
const editorUi = {
  content: 'markdown [&_.ProseMirror]:min-h-[60vh] [&_.ProseMirror]:px-3 [&_.ProseMirror]:py-2',
}

const item = computed(() => detail.value?.item ?? props.initial)
const held = computed(() => item.value?.labels.includes(props.holdLabel) ?? false)
// Runs come newest first; once Stop was pressed on it there is nothing more to press.
const stoppable = computed(() => {
  const run = detail.value?.runs[0]
  return run?.state === 'running' && run.cancelMode !== 'hard'
})
const more = computed(() => [
  {
    label: 'Move to',
    icon: 'i-lucide-columns-3',
    children: props.columns
      .filter((c) => c.status !== item.value?.status)
      // The rework status asks what to fix right here: a dialog of the board's own would sit
      // under this one, which takes every click outside itself.
      .map((c) => ({
        label: c.displayName,
        onSelect: () =>
          c.status === props.roles.rework ? (reworking.value = true) : emit('move', c.status),
      })),
  },
  {
    label: 'Delete item',
    icon: 'i-lucide-trash-2',
    color: 'error' as const,
    onSelect: () => (confirmingDelete.value = true),
  },
])

const body = computed(() => (item.value ? renderMarkdown(item.value.body, item.value.ref) : ''))
// Newest first on screen. The API keeps them oldest first, the order agents read them in.
const comments = computed(() =>
  (detail.value?.comments ?? [])
    .map((c) => ({
      ...c,
      html: renderMarkdown(c.body, props.itemRef),
    }))
    .reverse(),
)

// Bumped by every change made here. A read that started before one does not have it, and
// is read again rather than shown over it.
let edits = 0

async function load(): Promise<void> {
  const at = edits
  try {
    const read = await call<ItemDetail>(`/api/items/${encodeURIComponent(props.itemRef)}`)
    if (at !== edits) return load()
    detail.value = read
    error.value = ''
  } catch (e) {
    error.value = messageOf(e)
  }
}

// Every opening starts clean and reads afresh: someone may have edited or commented in the
// tracker meanwhile, and a draft left from last time is not what the person came back for.
watch(
  () => [open.value, props.itemRef] as const,
  async ([isOpen]) => {
    if (!isOpen) return
    detail.value = undefined
    editing.value = false
    reworking.value = false
    reworkDraft.value = ''
    commentDraft.value = ''
    confirmingDelete.value = false
    error.value = ''
    await load()
  },
  { immediate: true },
)

// The board read itself again and this item changed: the engine moved it, a Run started or
// ended. Not mid-edit, where it would replace what the person is reading.
watch(
  () => props.seen,
  () => {
    if (open.value && detail.value !== undefined && !editing.value) void load()
  },
)

function startEdit(): void {
  if (!item.value) return
  draftTitle.value = item.value.title
  draftBody.value = item.value.body
  editing.value = true
}

async function save(): Promise<void> {
  const current = detail.value
  if (!current) return
  const changes: { title?: string; body?: string } = {}
  if (draftTitle.value !== current.item.title) changes.title = draftTitle.value
  // An untouched body is not sent: rewriting it could only lose formatting.
  const body = toStoredMarkdown(draftBody.value)
  if (body !== current.item.body) changes.body = body
  if (changes.title === undefined && changes.body === undefined) {
    editing.value = false
    return
  }
  saving.value = true
  try {
    const item = await call<Item>(
      `/api/items/${encodeURIComponent(current.item.ref)}`,
      sendJson('PATCH', { expectedVersion: current.item.version, ...changes }),
    )
    if (detail.value) detail.value.item = item
    edits++
    editing.value = false
    error.value = ''
    emit('updated', item)
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.data.item) {
      // Theirs is shown underneath; the draft stays, and saving again replaces theirs.
      if (detail.value) detail.value.item = e.data.item
      emit('updated', e.data.item)
      toast.add({
        title: `${e.data.item.ref} was changed by someone else`,
        description: 'Your edit is still here. Check their version below, then save again.',
        color: 'warning',
      })
      return
    }
    toast.add({ title: messageOf(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function addComment(): Promise<void> {
  const current = detail.value
  if (!current) return
  commenting.value = true
  try {
    const comment = await call<Comment>(
      `/api/items/${encodeURIComponent(current.item.ref)}/comments`,
      sendJson('POST', { body: commentDraft.value }),
    )
    detail.value?.comments.push(comment)
    edits++
    commentDraft.value = ''
    error.value = ''
  } catch (e) {
    toast.add({ title: messageOf(e), color: 'error' })
  } finally {
    commenting.value = false
  }
}

// The attachment asking whether it should really go: deleting it cannot be undone. Its error
// shows by the list, where the person is looking, not at the top of the dialog.
const confirmingAttachment = ref<string>()
const removingAttachment = ref(false)
const attachmentError = ref('')
async function removeAttachment(a: Attachment): Promise<void> {
  removingAttachment.value = true
  try {
    await call(
      `/api/items/${encodeURIComponent(props.itemRef)}/attachments/${encodeURIComponent(a.id)}`,
      { method: 'DELETE' },
    )
    edits++
    confirmingAttachment.value = undefined
    attachmentError.value = ''
    // Read again: the deletion left a line among the comments.
    await load()
  } catch (e) {
    attachmentError.value = messageOf(e)
  } finally {
    removingAttachment.value = false
  }
}

async function upload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const current = detail.value
  if (!file || !current) return
  uploading.value = true
  try {
    const form = new FormData()
    form.append('file', file)
    const attachment = await call<Attachment>(
      `/api/items/${encodeURIComponent(current.item.ref)}/attachments`,
      { method: 'POST', body: form },
    )
    detail.value?.attachments.push(attachment)
    edits++
    error.value = ''
  } catch (e) {
    toast.add({ title: messageOf(e), color: 'error' })
  } finally {
    uploading.value = false
    input.value = ''
  }
}

function insert(attachment: Attachment): void {
  bodyEditor.value?.editor
    ?.chain()
    .focus()
    .setImage({ src: `attachment:${attachment.id}`, alt: attachment.filename })
    .run()
}

// Stop and hold leave the status alone; reading again shows the Run winding down.
async function control(action: 'stop' | 'hold' | 'release'): Promise<void> {
  const current = detail.value
  if (!current) return
  controlling.value = true
  try {
    const ref = encodeURIComponent(current.item.ref)
    const item = await call<Item>(
      action === 'stop' ? `/api/items/${ref}/stop` : `/api/items/${ref}/hold`,
      { method: action === 'stop' ? 'POST' : action === 'hold' ? 'PUT' : 'DELETE' },
    )
    emit('updated', item)
    await load()
  } catch (e) {
    toast.add({ title: messageOf(e), color: 'error' })
  } finally {
    controlling.value = false
  }
  // The engine ends a stopped agent within seconds: show it happen rather than leave
  // "stopping" up until the next opening.
  for (let i = 0; i < 30 && open.value; i++) {
    const run = detail.value?.runs[0]
    if (run?.state !== 'running' || run.cancelMode !== 'hard') break
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await load()
  }
}

async function remove(): Promise<void> {
  controlling.value = true
  try {
    await call(`/api/items/${encodeURIComponent(props.itemRef)}`, { method: 'DELETE' })
    emit('deleted', props.itemRef)
    open.value = false
  } catch (e) {
    toast.add({ title: messageOf(e), color: 'error' })
    confirmingDelete.value = false
  } finally {
    controlling.value = false
  }
}

// What a person can conclude in the item's status, as the workflow lists it, each button
// named after where it goes (D82). Going to the rework status asks what to fix first.
const outcomes = computed(() =>
  (props.columns.find((c) => c.status === item.value?.status)?.outcomes ?? []).map((to) => ({
    to,
    label: `→ ${props.columns.find((c) => c.status === to)?.displayName ?? to}`,
  })),
)

async function decide(to: string): Promise<void> {
  const current = detail.value
  if (!current) return
  moving.value = true
  try {
    const ref = encodeURIComponent(current.item.ref)
    const item = await call<Item>(
      to === props.roles.rework ? `/api/items/${ref}/rework` : `/api/items/${ref}/transition`,
      sendJson('POST', { from: current.item.status, to, feedback: reworkDraft.value }),
    )
    if (detail.value) detail.value.item = item
    edits++
    error.value = ''
    emit('updated', item)
    open.value = false
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.data.item) {
      if (detail.value) detail.value.item = e.data.item
      emit('updated', e.data.item)
      toast.add({
        title: `${e.data.item.ref} was moved by someone else`,
        description: `It is in ${props.statusName(e.data.item.status)} now.`,
        color: 'warning',
      })
      return
    }
    toast.add({ title: messageOf(e), color: 'error' })
  } finally {
    moving.value = false
  }
}

const taskStatus = (status: string): string => TASK_STATUS_DISPLAY[status] ?? status
const taskTitle = (ref: string): string =>
  detail.value?.tasks.find((t) => t.ref === ref)?.title ?? ref
// A blocker by its ref and title, so two tasks with similar titles cannot be mixed up.
const taskName = (ref: string): string => {
  const title = taskTitle(ref)
  return title === ref ? ref : `${ref} ${title}`
}

const isImage = (a: Attachment): boolean => a.mimeType.startsWith('image/')
const size = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const outcomeColor = (r: Run): 'primary' | 'success' | 'warning' | 'error' | 'neutral' =>
  r.outcome === undefined
    ? 'primary'
    : r.outcome === 'succeeded'
      ? 'success'
      : r.outcome === 'failed' || r.outcome === 'max_attempts'
        ? 'error'
        : r.outcome === 'needs_input' || r.outcome === 'blocked_manual'
          ? 'warning'
          : 'neutral'
const authorOf = (c: Comment): string =>
  c.author === 'human' ? (c.authorName ?? 'You') : c.author === 'agent' ? 'Agent' : 'Engine'
</script>

<template>
  <UModal
    v-model:open="open"
    :title="item?.ref ?? itemRef"
    :description="item ? statusName(item.status) : 'Loading…'"
    :ui="{
      content: 'sm:max-w-5xl',
      header: 'py-3 sm:py-3 min-h-0',
      description: 'sr-only',
      close: 'top-1.5 end-4',
    }"
  >
    <!-- Ref and status on one quiet line; the item's own title below is the heading. -->
    <template #title>
      <span class="flex items-center gap-2 text-sm">
        <span class="font-medium text-dimmed">{{ item?.ref ?? itemRef }}</span>
        <UBadge
          v-if="item"
          :label="statusName(item.status)"
          color="neutral"
          variant="subtle"
          size="sm"
        />
      </span>
    </template>
    <template #body>
      <div class="flex flex-col gap-8">
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <UAlert
          v-if="confirmingDelete"
          color="error"
          variant="subtle"
          :title="`Delete ${itemRef} with its tasks, comments and attachments?`"
          description="This cannot be undone."
          :actions="[
            {
              label: 'Keep it',
              color: 'neutral',
              variant: 'outline',
              onClick: () => (confirmingDelete = false),
            },
            { label: 'Delete for good', color: 'error', loading: controlling, onClick: remove },
          ]"
        />

        <template v-if="item">
          <section v-if="!editing" class="flex flex-col gap-3">
            <div class="flex items-start justify-between gap-4">
              <h2 class="flex items-center gap-2 text-xl font-semibold">
                {{ item.title }}
                <UBadge v-if="held" label="On hold" color="warning" variant="subtle" size="sm" />
              </h2>
              <span class="flex shrink-0 gap-2">
                <UButton
                  v-if="stoppable"
                  label="Stop"
                  color="error"
                  variant="outline"
                  size="sm"
                  :disabled="controlling"
                  @click="control('stop')"
                />
                <UButton
                  :label="held ? 'Release' : 'Hold'"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  :disabled="controlling || !detail"
                  @click="control(held ? 'release' : 'hold')"
                />
                <UButton
                  label="Edit"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  :disabled="!detail"
                  @click="startEdit"
                />
                <UDropdownMenu
                  :items="more"
                  :content="{ align: 'start' }"
                  :ui="{ itemLeadingIcon: 'size-4' }"
                >
                  <UButton
                    icon="i-lucide-ellipsis"
                    aria-label="More actions"
                    color="neutral"
                    variant="outline"
                    size="sm"
                  />
                </UDropdownMenu>
              </span>
            </div>
            <!-- eslint-disable-next-line vue/no-v-html -- markdown-it with html disabled -->
            <div v-if="item.body" class="markdown" v-html="body" />
            <p v-else class="text-sm text-muted">No description.</p>
          </section>

          <!-- Not a <form>: the editor toolbar buttons would submit it. -->
          <div v-else class="flex flex-col gap-3">
            <UFormField label="Title" required>
              <UInput v-model="draftTitle" required class="w-full" />
            </UFormField>
            <div class="flex flex-col gap-1">
              <span class="text-sm font-medium">Body</span>
              <UEditor
                ref="bodyEditor"
                v-slot="{ editor }"
                v-model="draftBody"
                content-type="markdown"
                :markdown="MARKDOWN_OPTIONS"
                :image="false"
                :mention="false"
                :extensions="extensions"
                :editor-props="EDITOR_PROPS"
                class="rounded-md border border-default"
                :ui="editorUi"
              >
                <UEditorToolbar
                  :editor="editor"
                  :items="EDITOR_TOOLBAR"
                  class="border-b border-default px-2 py-1"
                />
              </UEditor>
            </div>
            <div class="flex justify-end gap-2">
              <UButton label="Cancel" color="neutral" variant="outline" @click="editing = false" />
              <UButton label="Save" :loading="saving" @click="save" />
            </div>
          </div>
        </template>

        <template v-if="detail">
          <form
            v-if="reworking"
            class="flex flex-col gap-2"
            @submit.prevent="roles.rework && decide(roles.rework)"
          >
            <UFormField
              label="What to rework"
              help="The agent makes new tasks from this alone, so say what is wrong and what you expect."
            >
              <UTextarea v-model="reworkDraft" :rows="3" autoresize class="w-full" />
            </UFormField>
            <span class="flex justify-end gap-2">
              <UButton
                label="Cancel"
                color="neutral"
                variant="outline"
                @click="reworking = false"
              />
              <UButton
                type="submit"
                label="Send back for rework"
                :loading="moving"
                :disabled="reworkDraft.trim() === ''"
              />
            </span>
          </form>
        </template>

        <p v-if="!detail && !error" class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
          Loading tasks, runs and comments…
        </p>

        <template v-if="detail">
          <!-- Work on the left, what came with it on the right, so a row never stretches across
               the whole dialog. -->
          <div class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
            <div class="flex min-w-0 flex-col gap-8">
              <section aria-labelledby="tasks-heading" class="flex flex-col gap-2">
                <div class="flex items-center justify-between gap-2">
                  <h3 id="tasks-heading" class="text-sm font-semibold text-highlighted">Tasks</h3>
                  <!-- The last outcome is the way forward, so it is the solid one. -->
                  <span v-if="outcomes.length > 0" class="flex gap-2">
                    <UButton
                      v-for="({ to, label }, i) in outcomes"
                      :key="to"
                      :label="label"
                      size="sm"
                      :color="i === outcomes.length - 1 ? 'primary' : 'neutral'"
                      :variant="i === outcomes.length - 1 ? 'solid' : 'outline'"
                      :disabled="moving"
                      @click="to === roles.rework ? (reworking = true) : decide(to)"
                    />
                  </span>
                </div>
                <p v-if="detail.tasks.length === 0" class="text-sm text-muted">No tasks yet.</p>
                <ol class="flex flex-col">
                  <li v-for="t in detail.tasks" :key="t.ref" :aria-label="`Task ${t.title}`">
                    <!-- The whole row opens the task, so the status lines up with what it belongs to. -->
                    <button
                      type="button"
                      class="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto_6.5rem] items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
                      @click="openTask = t.ref"
                    >
                      <span class="flex min-w-0 flex-col">
                        <span class="truncate">
                          <span class="text-muted">{{ t.ref }}</span> {{ t.title }}
                        </span>
                        <span
                          v-if="t.blockedBy.length > 0"
                          class="flex items-center gap-1 truncate text-xs text-muted"
                        >
                          <UIcon name="i-lucide-corner-down-right" class="size-3.5 shrink-0" />
                          Waits for {{ t.blockedBy.map(taskName).join(', ') }}
                        </span>
                      </span>
                      <span class="text-xs text-muted">{{ t.origin }}</span>
                      <UBadge
                        :label="taskStatus(t.status)"
                        :color="TASK_COLOR[t.status] ?? 'neutral'"
                        variant="subtle"
                        size="sm"
                        class="justify-self-end"
                      />
                    </button>
                  </li>
                </ol>
              </section>

              <section aria-labelledby="comments-heading" class="flex flex-col gap-3">
                <h3 id="comments-heading" class="text-sm font-semibold text-highlighted">
                  Comments
                </h3>
                <form class="flex flex-col gap-2" @submit.prevent="addComment">
                  <UFormField label="Add a comment">
                    <UTextarea v-model="commentDraft" :rows="3" autoresize class="w-full" />
                  </UFormField>
                  <UButton
                    type="submit"
                    label="Comment"
                    :loading="commenting"
                    :disabled="commentDraft.trim() === ''"
                    class="self-end"
                  />
                </form>
                <p v-if="comments.length === 0" class="text-sm text-muted">No comments yet.</p>
                <article
                  v-for="c in comments"
                  :key="c.id"
                  :aria-label="`Comment by ${authorOf(c)}`"
                  class="rounded-md border border-default p-3"
                >
                  <p class="mb-1 flex items-center gap-2 text-xs text-muted">
                    <span class="font-medium text-default">{{ authorOf(c) }}</span>
                    <UBadge v-if="c.kind !== 'note'" :label="c.kind" size="sm" variant="subtle" />
                    <time :datetime="c.createdAt">{{
                      new Date(c.createdAt).toLocaleString()
                    }}</time>
                  </p>
                  <!-- eslint-disable-next-line vue/no-v-html -- markdown-it with html disabled -->
                  <div class="markdown" v-html="c.html" />
                </article>
              </section>
            </div>
            <aside
              class="order-first flex min-w-0 flex-col gap-8 lg:order-none lg:border-l lg:border-default lg:pl-6"
            >
              <section aria-labelledby="attachments-heading" class="flex flex-col gap-2">
                <div class="flex items-center justify-between">
                  <h3 id="attachments-heading" class="text-sm font-semibold text-highlighted">
                    Attachments
                  </h3>
                  <!-- The browser's own file input reads "Choose file, no file chosen" in the
                       system language; a button opens it instead. -->
                  <input
                    ref="fileInput"
                    type="file"
                    aria-label="Attach a file"
                    tabindex="-1"
                    class="sr-only"
                    :disabled="uploading"
                    @change="upload"
                  />
                  <UButton
                    label="Attach"
                    icon="i-lucide-paperclip"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    :loading="uploading"
                    @click="fileInput?.click()"
                  />
                </div>
                <p v-if="detail.attachments.length === 0" class="text-sm text-muted">None yet.</p>
                <ul class="flex flex-col gap-2">
                  <li
                    v-for="a in detail.attachments"
                    :key="a.id"
                    class="flex min-w-0 items-center gap-3 text-sm"
                  >
                    <!-- Every attachment the same row; an image's square is its thumbnail. -->
                    <button
                      v-if="isImage(a)"
                      type="button"
                      :aria-label="`Preview ${a.filename}`"
                      class="size-11 shrink-0 cursor-zoom-in overflow-hidden rounded-md bg-elevated ring-1 ring-(--ui-border-muted) focus-visible:outline-2 focus-visible:outline-primary"
                      @click="preview = a"
                    >
                      <img
                        :src="attachmentUrl(detail.item.ref, a.id)"
                        alt=""
                        loading="lazy"
                        class="size-full object-cover"
                      />
                    </button>
                    <span
                      v-else
                      class="flex size-11 shrink-0 items-center justify-center rounded-md bg-elevated text-muted"
                    >
                      <UIcon name="i-lucide-file" class="size-5" />
                    </span>
                    <span class="flex min-w-0 flex-col">
                      <a
                        :href="attachmentUrl(detail.item.ref, a.id)"
                        target="_blank"
                        class="truncate hover:underline"
                      >
                        {{ a.filename }}
                      </a>
                      <span class="text-xs text-muted">{{ size(a.size) }}</span>
                    </span>
                    <span class="ml-auto flex shrink-0 items-center gap-1">
                      <UButton
                        v-if="editing && isImage(a)"
                        label="Insert"
                        :aria-label="`Insert ${a.filename}`"
                        size="xs"
                        color="neutral"
                        variant="outline"
                        @click="insert(a)"
                      />
                      <template v-if="confirmingAttachment === a.id">
                        <UButton
                          label="Keep"
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          @click="confirmingAttachment = undefined"
                        />
                        <UButton
                          label="Delete"
                          :aria-label="`Delete ${a.filename} for good`"
                          size="xs"
                          color="error"
                          :loading="removingAttachment"
                          @click="removeAttachment(a)"
                        />
                      </template>
                      <UButton
                        v-else
                        icon="i-lucide-trash-2"
                        :aria-label="`Delete ${a.filename}`"
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        class="text-dimmed hover:text-error"
                        @click="((confirmingAttachment = a.id), (attachmentError = ''))"
                      />
                    </span>
                  </li>
                </ul>
                <p v-if="attachmentError" role="alert" class="text-sm text-error">
                  {{ attachmentError }}
                </p>
              </section>

              <section aria-labelledby="runs-heading" class="flex flex-col gap-2">
                <h3 id="runs-heading" class="text-sm font-semibold text-highlighted">Runs</h3>
                <p v-if="detail.runs.length === 0" class="text-sm text-muted">
                  No agent has worked on it.
                </p>
                <ul class="flex flex-col gap-2">
                  <li
                    v-for="r in detail.runs"
                    :key="r.id"
                    :aria-label="`Run ${r.rule} attempt ${r.attempt}`"
                    class="flex flex-col gap-0.5 text-sm"
                  >
                    <span class="flex items-center gap-2">
                      <span
                        ><code class="font-mono">{{ r.rule }}</code>, attempt {{ r.attempt
                        }}<template v-if="r.target !== detail.item.ref">
                          on {{ taskTitle(r.target) }}</template
                        ></span
                      >
                      <UBadge
                        :label="r.outcome ?? (r.cancelMode === undefined ? 'running' : 'stopping')"
                        :color="outcomeColor(r)"
                        variant="subtle"
                        size="sm"
                      />
                    </span>
                    <span
                      v-if="r.from && r.target === detail.item.ref"
                      class="flex flex-wrap items-center gap-1"
                    >
                      <UBadge
                        :label="statusName(r.from)"
                        color="neutral"
                        variant="outline"
                        size="sm"
                      />
                      <template v-if="r.to">
                        <span aria-hidden="true" class="text-muted">→</span>
                        <span class="sr-only">to</span>
                        <UBadge
                          :label="statusName(r.to)"
                          color="neutral"
                          variant="outline"
                          size="sm"
                        />
                      </template>
                    </span>
                    <time :datetime="r.startedAt" class="text-xs text-muted">
                      {{ new Date(r.startedAt).toLocaleString() }}
                    </time>
                  </li>
                </ul>
              </section>
            </aside>
          </div>

          <TaskDetail
            v-if="openTask"
            v-model:open="taskOpen"
            :task-ref="openTask"
            :agent-working="detail.runs[0]?.state === 'running'"
            :task-title="taskTitle"
            @changed="load"
          />

          <UModal
            :open="preview !== undefined"
            :title="preview?.filename ?? ''"
            :ui="{ content: 'sm:max-w-4xl' }"
            @update:open="(v) => !v && (preview = undefined)"
          >
            <template #body>
              <img
                v-if="preview"
                :src="attachmentUrl(detail.item.ref, preview.id)"
                :alt="preview.filename"
                class="mx-auto max-h-[75vh] rounded-lg object-contain"
              />
            </template>
          </UModal>
        </template>
      </div>
    </template>
  </UModal>
</template>
