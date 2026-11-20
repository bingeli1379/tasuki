<script setup lang="ts">
import type { EditorToolbarItem } from '@nuxt/ui'
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
import { AttachmentImage, Embed, toStoredMarkdown } from '../editor'
import { renderMarkdown } from '../markdown'

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
const toast = useToast()
const bodyEditor = useTemplateRef('bodyEditor')

// Passed to UEditor once: a new object on each render makes it rebuild the editor and
// register its plugins twice ("Adding different instances of a keyed plugin").
const extensions = [Embed, AttachmentImage.configure({ itemRef: props.itemRef })]
const markdownOptions = { markedOptions: { gfm: true, breaks: true } }
const editorProps = { attributes: { 'aria-label': 'Body' } }
const editorUi = { content: 'markdown min-h-[60vh] px-3 py-2' }
// Text buttons rather than icons: icons would be fetched from the Iconify API at runtime,
// which an offline company network cannot reach.
const toolbar: EditorToolbarItem[][] = [
  [
    { kind: 'heading', level: 2, label: 'H2', 'aria-label': 'Heading' },
    { kind: 'mark', mark: 'bold', label: 'B', 'aria-label': 'Bold' },
    { kind: 'mark', mark: 'italic', label: 'I', 'aria-label': 'Italic' },
    { kind: 'mark', mark: 'strike', label: 'S', 'aria-label': 'Strikethrough' },
    { kind: 'mark', mark: 'code', label: '<>', 'aria-label': 'Inline code' },
  ],
  [
    { kind: 'bulletList', label: '•', 'aria-label': 'Bullet list' },
    { kind: 'orderedList', label: '1.', 'aria-label': 'Numbered list' },
    { kind: 'blockquote', label: '❝', 'aria-label': 'Quote' },
    { kind: 'codeBlock', label: '{ }', 'aria-label': 'Code block' },
  ],
]

const body = computed(() =>
  detail.value ? renderMarkdown(detail.value.item.body, detail.value.item.ref) : '',
)
const comments = computed(() =>
  (detail.value?.comments ?? []).map((c) => ({
    ...c,
    html: renderMarkdown(c.body, props.itemRef),
  })),
)

// Every opening reads afresh: someone may have edited or commented in the tracker meanwhile.
watch(
  () => [open.value, props.itemRef] as const,
  async ([isOpen, itemRef]) => {
    if (!isOpen) return
    detail.value = undefined
    editing.value = false
    error.value = ''
    try {
      detail.value = await call<ItemDetail>(`/api/items/${encodeURIComponent(itemRef)}`)
    } catch (e) {
      error.value = messageOf(e)
    }
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
                :markdown="markdownOptions"
                :image="false"
                :mention="false"
                :extensions="extensions"
                :editor-props="editorProps"
                class="rounded-md border border-default"
                :ui="editorUi"
              >
                <UEditorToolbar
                  :editor="editor"
                  :items="toolbar"
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
