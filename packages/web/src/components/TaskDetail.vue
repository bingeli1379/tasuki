<script setup lang="ts">
import { TASK_STATUS_DISPLAY } from '@tasuki/core'
import { computed, ref, watch } from 'vue'
import { ApiError, call, messageOf, sendJson, type Comment, type TaskDetail } from '../api'
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

const props = defineProps<{
  taskRef: string
  // Tasks are edited and deleted only while the item is in the taskReview status.
  itemStatus: string
  taskReview: string | undefined
  taskTitle: (ref: string) => string
}>()
// The item detail reads its task list again after any change made here.
const emit = defineEmits<{ changed: [] }>()
const open = defineModel<boolean>('open', { required: true })

const detail = ref<TaskDetail>()
const error = ref('')
const busy = ref(false)
const editing = ref(false)
const draftTitle = ref('')
const draftBody = ref('')
const confirmingDelete = ref(false)
const commentDraft = ref('')
const toast = useToast()

const extensions = [Embed, AttachmentImage.configure({ itemRef: props.taskRef })]
const editorUi = {
  content: 'markdown [&_.ProseMirror]:min-h-[30vh] [&_.ProseMirror]:px-3 [&_.ProseMirror]:py-2',
}

const editable = computed(
  () => props.taskReview !== undefined && props.itemStatus === props.taskReview,
)
const body = computed(() =>
  detail.value ? renderMarkdown(detail.value.task.body, detail.value.task.ref) : '',
)
// Newest first on screen. The API keeps them oldest first, the order agents read them in.
const comments = computed(() =>
  (detail.value?.comments ?? [])
    .map((c) => ({
      ...c,
      html: renderMarkdown(c.body, props.taskRef),
    }))
    .reverse(),
)
// The person's edges of the task diagram (state-machine.md, D74).
const moves = computed((): { label: string; to: string }[] => {
  switch (detail.value?.task.status) {
    case 'to-do':
    case 'in-progress':
      return [{ label: 'Take over', to: 'manual' }]
    case 'manual':
      return [
        { label: 'Hand back', to: 'to-do' },
        { label: 'Mark done', to: 'done' },
      ]
    case 'done':
      return [
        { label: 'Reopen as To Do', to: 'to-do' },
        { label: 'Reopen as Manual', to: 'manual' },
      ]
    default:
      return []
  }
})

// Bumped by every change made here. A read that started before one does not have it, and
// is read again rather than shown over it.
let edits = 0

async function load(): Promise<void> {
  const at = edits
  try {
    const read = await call<TaskDetail>(`/api/tasks/${encodeURIComponent(props.taskRef)}`)
    if (at !== edits) return load()
    detail.value = read
    error.value = ''
  } catch (e) {
    error.value = messageOf(e)
  }
}

watch(
  () => [open.value, props.taskRef] as const,
  async ([isOpen]) => {
    if (!isOpen) return
    detail.value = undefined
    editing.value = false
    confirmingDelete.value = false
    await load()
  },
  { immediate: true },
)

// A 409 carries the task as it is now; show it and let the person decide again.
async function act(work: () => Promise<void>, conflict: string): Promise<void> {
  busy.value = true
  try {
    await work()
    error.value = ''
    emit('changed')
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      toast.add({ title: conflict, color: 'warning' })
      await load()
      emit('changed')
      return
    }
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}

const move = (to: string): Promise<void> =>
  act(async () => {
    const current = detail.value
    if (!current) return
    const moved = await call<TaskDetail['task']>(
      `/api/tasks/${encodeURIComponent(current.task.ref)}/transition`,
      sendJson('POST', { from: current.task.status, to }),
    )
    // What the write returned is shown at once; the log line it left comes in with a read
    // in the background, which costs Jira seconds.
    if (detail.value) detail.value.task = { ...detail.value.task, ...moved }
    edits++
    void load()
  }, `${props.taskRef} was moved by someone else`)

function startEdit(): void {
  if (!detail.value) return
  draftTitle.value = detail.value.task.title
  draftBody.value = detail.value.task.body
  editing.value = true
}

const save = (): Promise<void> =>
  act(async () => {
    const current = detail.value
    if (!current) return
    const changes: { title?: string; body?: string } = {}
    if (draftTitle.value !== current.task.title) changes.title = draftTitle.value
    const stored = toStoredMarkdown(draftBody.value)
    if (stored !== current.task.body) changes.body = stored
    if (changes.title !== undefined || changes.body !== undefined) {
      const edited = await call<TaskDetail['task']>(
        `/api/tasks/${encodeURIComponent(current.task.ref)}`,
        sendJson('PATCH', { expectedVersion: current.task.version, ...changes }),
      )
      if (detail.value) detail.value.task = { ...detail.value.task, ...edited }
      edits++
    }
    editing.value = false
  }, `${props.taskRef} was changed by someone else; your edit is still here`)

// Closing unmounts this component, so it closes only after act has emitted changed.
async function remove(): Promise<void> {
  await act(async () => {
    await call(`/api/tasks/${encodeURIComponent(props.taskRef)}`, { method: 'DELETE' })
  }, `${props.taskRef} was changed by someone else`)
  if (error.value === '') open.value = false
}

async function addComment(): Promise<void> {
  const current = detail.value
  if (!current) return
  busy.value = true
  try {
    const comment = await call<Comment>(
      `/api/tasks/${encodeURIComponent(current.task.ref)}/comments`,
      sendJson('POST', { body: commentDraft.value }),
    )
    detail.value?.comments.push(comment)
    edits++
    commentDraft.value = ''
    error.value = ''
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}

const authorOf = (c: Comment): string =>
  c.author === 'human' ? (c.authorName ?? 'You') : c.author === 'agent' ? 'Agent' : 'Engine'
</script>

<template>
  <UModal
    v-model:open="open"
    :title="detail?.task.ref ?? taskRef"
    :description="detail ? `Task of ${detail.task.parent}` : 'Loading…'"
    :ui="{ content: 'sm:max-w-3xl' }"
  >
    <template #body>
      <div class="flex flex-col gap-6">
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />

        <template v-if="detail">
          <UAlert
            v-if="confirmingDelete"
            color="error"
            variant="subtle"
            :title="`Delete ${detail.task.ref} and its comments?`"
            description="This cannot be undone."
            :actions="[
              {
                label: 'Keep it',
                color: 'neutral',
                variant: 'outline',
                onClick: () => (confirmingDelete = false),
              },
              { label: 'Delete for good', color: 'error', loading: busy, onClick: remove },
            ]"
          />
          <section v-if="!editing" class="flex flex-col gap-3">
            <div class="flex items-start justify-between gap-4">
              <h2 class="flex items-center gap-2 text-xl font-semibold">
                {{ detail.task.title }}
                <UBadge
                  :label="TASK_STATUS_DISPLAY[detail.task.status] ?? detail.task.status"
                  :color="TASK_COLOR[detail.task.status] ?? 'neutral'"
                  variant="subtle"
                  size="sm"
                />
              </h2>
              <span class="flex shrink-0 gap-2">
                <UButton
                  v-for="m in moves"
                  :key="m.to"
                  :label="m.label"
                  size="sm"
                  :color="m.to === 'done' ? 'primary' : 'neutral'"
                  :variant="m.to === 'done' ? 'solid' : 'outline'"
                  :disabled="busy"
                  @click="move(m.to)"
                />
                <UButton
                  v-if="editable"
                  label="Edit"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  @click="startEdit"
                />
                <UButton
                  v-if="editable"
                  label="Delete task"
                  color="error"
                  variant="outline"
                  size="sm"
                  :disabled="busy"
                  @click="confirmingDelete = true"
                />
              </span>
            </div>
            <p class="flex flex-wrap gap-x-3 text-xs text-muted">
              <span v-if="detail.task.origin">from {{ detail.task.origin }}</span>
              <span v-if="detail.task.blockedBy.length > 0" class="flex items-center gap-1">
                <UIcon name="i-lucide-corner-down-right" class="size-3.5 shrink-0" />
                Waits for
                {{
                  detail.task.blockedBy
                    .map((r) => (taskTitle(r) === r ? r : `${r} ${taskTitle(r)}`))
                    .join(', ')
                }}
              </span>
            </p>
            <!-- eslint-disable-next-line vue/no-v-html -- markdown-it with html disabled -->
            <div v-if="detail.task.body" class="markdown" v-html="body" />
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
            <div class="flex items-center justify-end gap-2">
              <span class="flex gap-2">
                <UButton
                  label="Cancel"
                  color="neutral"
                  variant="outline"
                  @click="editing = false"
                />
                <UButton label="Save" :loading="busy" @click="save" />
              </span>
            </div>
          </div>

          <section aria-labelledby="task-comments-heading" class="flex flex-col gap-3">
            <h3 id="task-comments-heading" class="text-sm font-medium">Comments</h3>
            <form class="flex flex-col gap-2" @submit.prevent="addComment">
              <UFormField label="Add a comment">
                <UTextarea v-model="commentDraft" :rows="2" autoresize class="w-full" />
              </UFormField>
              <UButton
                type="submit"
                label="Comment"
                :loading="busy"
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
                <time :datetime="c.createdAt">{{ new Date(c.createdAt).toLocaleString() }}</time>
              </p>
              <!-- eslint-disable-next-line vue/no-v-html -- markdown-it with html disabled -->
              <div class="markdown" v-html="c.html" />
            </article>
          </section>
        </template>
      </div>
    </template>
  </UModal>
</template>
