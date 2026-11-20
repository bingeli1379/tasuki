import { ATTACHMENT_SCHEME, formatEmbed } from '@tasuki/core'
import { mergeAttributes, Node } from '@tiptap/core'
import Image, { type ImageOptions } from '@tiptap/extension-image'
import { attachmentUrl } from './api'

const EMBED_AT_START = /^\[\[embed:([^|\]\n]*)\|([A-Za-z0-9+/=]+)\]\]/

// Tracker content markdown cannot express (a Jira mention, a table) as one chip: it can be
// deleted but not edited, and saves back as the exact token it came from.
export const Embed: Node = Node.create({
  name: 'embed',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return { label: { default: '' }, payload: { default: '' } }
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-embed]',
        getAttrs: (el) => ({ label: el.textContent, payload: el.getAttribute('data-embed') }),
      },
    ]
  },
  renderHTML({ node }) {
    return [
      'span',
      {
        class: 'embed',
        'data-embed': String(node.attrs['payload']),
        title: 'Kept from the tracker; edit it there',
      },
      String(node.attrs['label']),
    ]
  },

  markdownTokenName: 'embed',
  markdownTokenizer: {
    name: 'embed',
    level: 'inline',
    start: (src) => src.indexOf('[[embed:'),
    tokenize(src) {
      const m = EMBED_AT_START.exec(src)
      return m ? { type: 'embed', raw: m[0], label: m[1], payload: m[2] } : undefined
    },
  },
  parseMarkdown: (token) => ({
    type: 'embed',
    attrs: { label: String(token['label']), payload: String(token['payload']) },
  }),
  renderMarkdown: (node) =>
    formatEmbed(String(node.attrs?.['label'] ?? ''), String(node.attrs?.['payload'] ?? '')),
})

// Keeps src as attachment:<id> so markdown saves unchanged; only the page loads the real URL.
export const AttachmentImage: Node = Image.extend<ImageOptions & { itemRef: string }>({
  addOptions() {
    return { ...this.parent!(), itemRef: '' }
  },
  renderHTML({ HTMLAttributes }) {
    const src = String(HTMLAttributes['src'] ?? '')
    return [
      'img',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        src: src.startsWith(ATTACHMENT_SCHEME)
          ? attachmentUrl(this.options.itemRef, src.slice(ATTACHMENT_SCHEME.length))
          : src,
      }),
    ]
  },
})

// Undoes two habits of the editor's serializer that stored markdown does not share, outside
// code: a line break written as two trailing spaces (a plain newline is a line break here),
// and an underscore escaped inside a word (snake_case is never emphasis in GFM).
export function toStoredMarkdown(markdown: string): string {
  let inFence = false
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
      if (inFence) return line
      return line
        .replace(/ {2}$/, '')
        .split('`')
        .map((part, i) =>
          i % 2 === 1 ? part : part.replace(/(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, '_'),
        )
        .join('`')
    })
    .join('\n')
}
