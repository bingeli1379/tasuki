<script setup lang="ts">
import { TASK_STATUS_DISPLAY } from '@tasuki/core'
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
import TaskDetail from './TaskDetail.vue'

const props = defineProps<{ itemRef: string; statusName: (status: string) => string }>()
const emit = defineEmits<{ updated: [item: Item] }>()
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
const reworking = ref(false)
const reworkDraft = ref('')
const openTask = ref<string>()
const taskOpen = computed({
  get: () => openTask.value !== undefined,
  set: (value) => {
    if (!value) openTask.value = undefined
  },
})
const toast = useToast()
const bodyEditor = useTemplateRef('bodyEditor')

// Passed to UEditor once: a new object on each render makes it rebuild the editor and
// register its plugins twice ("Adding different instances of a keyed plugin").
const extensions = [Embed, AttachmentImage.configure({ itemRef: props.itemRef })]
// On the editable element itself, not the wrapper: padding and height on the wrapper are
// blank space a click does not reach the editor through.
const editorUi = {
  content: 'markdown [&_.ProseMirror]:min-h-[60vh] [&_.ProseMirror]:px-3 [&_.ProseMirror]:py-2',
}

const body = computed(() =>
  detail.value ? renderMarkdown(detail.value.item.body, detail.value.item.ref) : '',
)
const comments = computed(() =>
  (detail.value?.comments ?? []).map((c) => ({
    ...c,
    html: renderMarkdown(c.body, props.itemRef),
  })),
)

async function load(): Promise<void> {
  try {
    detail.value = await call<ItemDetail>(`/api/items/${encodeURIComponent(props.itemRef)}`)
    error.value = ''
  } catch (e) {
    error.value = messageOf(e)
  }
}

// Every opening reads afresh: someone may have edited or commented in the tracker meanwhile.
watch(
  () => [open.value, props.itemRef] as const,
  async ([isOpen]) => {
    if (!isOpen) return
    detail.value = undefined
    editing.value = false
    error.value = ''
    await load()
  },
  { immediate: true },
)

function startEdit(): void {
  if (!detail.value) return
  draftTitle.value = detail.value.item.title
  draftBody.value = detail.value.item.body
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
    current.item = item
    editing.value = false
    error.value = ''
    emit('updated', item)
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.data.item) {
      // Theirs is shown underneath; the draft stays, and saving again replaces theirs.
      current.item = e.data.item
      emit('updated', e.data.item)
      toast.add({
        title: `${e.data.item.ref} was changed by someone else`,
        description: 'Your edit is still here. Check their version below, then save again.',
        color: 'warning',
      })
      return
    }
    error.value = messageOf(e)
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
    current.comments.push(comment)
    commentDraft.value = ''
    error.value = ''
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    commenting.value = false
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
    current.attachments.push(attachment)
    error.value = ''
  } catch (e) {
    error.value = messageOf(e)
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

// split-review is where a person checks the tasks before any of them runs, in-review where
// they accept the finished work or send it back with what to fix.
async function decide(to: string): Promise<void> {
  const current = detail.value
  if (!current) return
  moving.value = true
  try {
    const ref = encodeURIComponent(current.item.ref)
    const item = await call<Item>(
      to === 'ready-to-rework' ? `/api/items/${ref}/rework` : `/api/items/${ref}/transition`,
      sendJson('POST', { from: current.item.status, to, feedback: reworkDraft.value }),
    )
    current.item = item
    error.value = ''
    emit('updated', item)
    open.value = false
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.data.item) {
      current.item = e.data.item
      emit('updated', e.data.item)
      toast.add({
        title: `${e.data.item.ref} was moved by someone else`,
        description: `It is in ${props.statusName(e.data.item.status)} now.`,
        color: 'warning',
      })
      return
    }
    error.value = messageOf(e)
  } finally {
    moving.value = false
  }
}

const taskStatus = (status: string): string => TASK_STATUS_DISPLAY[status] ?? status
const taskTitle = (ref: string): string =>
  detail.value?.tasks.find((t) => t.ref === ref)?.title ?? ref

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
    :title="detail?.item.ref ?? itemRef"
    :description="detail ? statusName(detail.item.status) : 'Loading…'"
    :ui="{ content: 'sm:max-w-5xl' }"
  >
    <template #body>
      <div class="flex flex-col gap-6">
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />

        <template v-if="detail">
          <section v-if="!editing" class="flex flex-col gap-3">
            <div class="flex items-start justify-between gap-4">
              <h2 class="text-xl font-semibold">{{ detail.item.title }}</h2>
              <UButton
                label="Edit"
                color="neutral"
                variant="outline"
                size="sm"
                @click="startEdit"
              />
            </div>
            <!-- eslint-disable-next-line vue/no-v-html -- markdown-it with html disabled -->
            <div v-if="detail.item.body" class="markdown" v-html="body" />
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
              <UButton label="Cancel" color="neutral" variant="ghost" @click="editing = false" />
              <UButton label="Save" :loading="saving" @click="save" />
            </div>
          </div>

          <section aria-labelledby="attachments-heading" class="flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <h3 id="attachments-heading" class="text-sm font-medium">Attachments</h3>
              <label>
                <span class="sr-only">Attach a file</span>
                <input
                  type="file"
                  class="text-sm file:mr-2 file:rounded file:border-0 file:bg-elevated file:px-2 file:py-1"
                  :disabled="uploading"
                  @change="upload"
                />
              </label>
            </div>
            <p v-if="detail.attachments.length === 0" class="text-sm text-muted">None yet.</p>
            <ul class="flex flex-col gap-1">
              <li
                v-for="a in detail.attachments"
                :key="a.id"
                class="flex items-center justify-between gap-2 text-sm"
              >
                <a
                  :href="attachmentUrl(detail.item.ref, a.id)"
                  target="_blank"
                  class="truncate underline"
                >
                  {{ a.filename }}
                </a>
                <span class="flex shrink-0 items-center gap-2 text-muted">
                  {{ size(a.size) }}
                  <UButton
                    v-if="editing && isImage(a)"
                    :label="`Insert ${a.filename}`"
                    size="xs"
                    color="neutral"
                    variant="outline"
                    @click="insert(a)"
                  />
                </span>
              </li>
            </ul>
          </section>

          <section aria-labelledby="tasks-heading" class="flex flex-col gap-2">
            <div class="flex items-center justify-between gap-2">
              <h3 id="tasks-heading" class="text-sm font-medium">Tasks</h3>
              <span v-if="detail.item.status === 'split-review'" class="flex gap-2">
                <UButton
                  label="Send back"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  :disabled="moving"
                  @click="decide('refining')"
                />
                <UButton
                  label="Approve"
                  size="sm"
                  :loading="moving"
                  :disabled="detail.tasks.length === 0"
                  @click="decide('in-progress')"
                />
              </span>
              <span v-else-if="detail.item.status === 'in-review'" class="flex gap-2">
                <UButton
                  label="Rework"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  :disabled="moving"
                  @click="reworking = true"
                />
                <UButton label="Accept" size="sm" :loading="moving" @click="decide('done')" />
              </span>
            </div>
            <form
              v-if="reworking && detail.item.status === 'in-review'"
              class="flex flex-col gap-2"
              @submit.prevent="decide('ready-to-rework')"
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
                  variant="ghost"
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
            <p v-if="detail.tasks.length === 0" class="text-sm text-muted">No tasks yet.</p>
            <ol class="flex flex-col gap-1">
              <li
                v-for="t in detail.tasks"
                :key="t.ref"
                :aria-label="`Task ${t.title}`"
                class="flex items-center justify-between gap-2 text-sm"
              >
                <span class="flex min-w-0 flex-col items-start">
                  <button
                    type="button"
                    class="max-w-full truncate text-left hover:underline"
                    @click="openTask = t.ref"
                  >
                    <span class="text-muted">{{ t.ref }}</span> {{ t.title }}
                  </button>
                  <span v-if="t.blockedBy.length > 0" class="text-xs text-muted">
                    after {{ t.blockedBy.map(taskTitle).join(', ') }}
                  </span>
                </span>
                <span class="flex shrink-0 items-center gap-2 text-muted">
                  <span v-if="t.origin" class="text-xs">{{ t.origin }}</span>
                  <UBadge
                    :label="taskStatus(t.status)"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                  />
                </span>
              </li>
            </ol>
          </section>

          <TaskDetail
            v-if="openTask"
            v-model:open="taskOpen"
            :task-ref="openTask"
            :item-status="detail.item.status"
            :task-title="taskTitle"
            @changed="load"
          />

          <section aria-labelledby="runs-heading" class="flex flex-col gap-2">
            <h3 id="runs-heading" class="text-sm font-medium">Runs</h3>
            <p v-if="detail.runs.length === 0" class="text-sm text-muted">
              No agent has worked on it.
            </p>
            <ul class="flex flex-col gap-1">
              <li
                v-for="r in detail.runs"
                :key="r.id"
                :aria-label="`Run ${r.rule} attempt ${r.attempt}`"
                class="flex items-center justify-between gap-2 text-sm"
              >
                <span>{{ r.rule }} · attempt {{ r.attempt }}</span>
                <span class="flex shrink-0 items-center gap-2 text-muted">
                  <time :datetime="r.startedAt">{{ new Date(r.startedAt).toLocaleString() }}</time>
                  <UBadge
                    :label="r.outcome ?? 'running'"
                    :color="outcomeColor(r)"
                    variant="subtle"
                    size="sm"
                  />
                </span>
              </li>
            </ul>
          </section>

          <section aria-labelledby="comments-heading" class="flex flex-col gap-3">
            <h3 id="comments-heading" class="text-sm font-medium">Comments</h3>
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
          </section>
        </template>
      </div>
    </template>
  </UModal>
</template>
