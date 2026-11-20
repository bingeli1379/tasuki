import { ATTACHMENT_SCHEME, EMBED_PATTERN, formatEmbed } from '@tasuki/core'
import { markdownToAdf as parseMarkdown } from 'marklassian'

export interface AdfNode {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  content?: AdfNode[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
}

export interface AdfDoc {
  type: 'doc'
  version: 1
  content: AdfNode[]
}

// What a Jira media node (an image in a description) points at, keyed by its media id.
export type MediaMap = ReadonlyMap<string, { id: string; filename: string }>

// Turns ![alt](attachment:<id>) into the Jira media id of that attachment.
export type MediaResolver = (attachmentId: string) => Promise<string>

const INLINE_TYPES = new Set([
  'text',
  'hardBreak',
  'mention',
  'emoji',
  'date',
  'status',
  'inlineCard',
  'mediaInline',
  'placeholder',
  'inlineExtension',
])

// ADF attributes are untyped JSON; read one as text only when it is text.
const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const encode = (node: AdfNode): string =>
  Buffer.from(JSON.stringify(node), 'utf8').toString('base64')
const decode = (payload: string): AdfNode =>
  JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as AdfNode

function embedLabel(node: AdfNode): string {
  const a = node.attrs ?? {}
  switch (node.type) {
    case 'mention':
      return `@${str(a['text']).replace(/^@/, '')}`
    case 'emoji':
      return str(a['text'], str(a['shortName'], 'emoji'))
    case 'date':
      return new Date(Number(a['timestamp'])).toISOString().slice(0, 10)
    case 'status':
      return str(a['text'], 'status')
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return str(a['url'], node.type)
    default:
      return node.type
  }
}

const embed = (node: AdfNode): string => formatEmbed(embedLabel(node), encode(node))

// ---- ADF -> markdown ----

function escapeText(text: string): string {
  return (
    text
      .replace(/[\\`*[\]~<]/g, '\\$&')
      // An underscore inside a word is not emphasis in GFM, so snake_case stays readable.
      .replace(/(^|[^\p{L}\p{N}])_|_(?=$|[^\p{L}\p{N}])/gu, (m) => m.replace('_', '\\_'))
  )
}

// Line starts that markdown would read as a block (heading, list, quote, rule).
// A backslash only escapes punctuation, so a numbered line escapes its dot, not the digit.
const escapeLineStarts = (text: string): string =>
  text.replace(/^(\s*)(#{1,6}\s|>|[-+]\s)/gm, '$1\\$2').replace(/^(\s*\d+)([.)]\s)/gm, '$1\\$2')

function withMarks(node: AdfNode): string {
  const marks = node.marks ?? []
  const has = (type: string): boolean => marks.some((m) => m.type === type)
  let out = has('code') ? `\`${node.text ?? ''}\`` : escapeText(node.text ?? '')
  if (has('strike')) out = `~~${out}~~`
  if (has('em')) out = `_${out}_`
  if (has('strong')) out = `**${out}**`
  const link = marks.find((m) => m.type === 'link')
  if (link) out = `[${out}](${str(link.attrs?.['href'])})`
  return out
}

function inline(nodes: AdfNode[] | undefined): string {
  const text = (nodes ?? [])
    .map((n) => {
      if (n.type === 'text') return withMarks(n)
      if (n.type === 'hardBreak') return '\n'
      return embed(n)
    })
    .join('')
  return escapeLineStarts(text)
}

const indent = (text: string, by: number): string =>
  text
    .split('\n')
    .map((line, i) => (i === 0 || line === '' ? line : ' '.repeat(by) + line))
    .join('\n')

function media(node: AdfNode, mediaMap: MediaMap): string | undefined {
  const m = node.content?.find((c) => c.type === 'media')
  if (m?.attrs?.['type'] !== 'file') return undefined
  const target = mediaMap.get(String(m.attrs['id']))
  if (!target) return undefined
  const alt = typeof m.attrs['alt'] === 'string' ? m.attrs['alt'] : target.filename
  return `![${escapeText(alt)}](${ATTACHMENT_SCHEME}${target.id})`
}

function block(node: AdfNode, mediaMap: MediaMap): string | undefined {
  switch (node.type) {
    case 'paragraph': {
      const text = inline(node.content)
      return text === '' ? undefined : text
    }
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.['level'] ?? 1))} ${inline(node.content)}`
    case 'bulletList':
    case 'orderedList': {
      let n = Number(node.attrs?.['order'] ?? 1)
      return (node.content ?? [])
        .map((item) => {
          const marker = node.type === 'bulletList' ? '-' : `${n++}.`
          const body = (item.content ?? [])
            .map((child) => block(child, mediaMap))
            .filter((b) => b !== undefined)
            .join('\n')
          return `${marker} ${indent(body, marker.length + 1)}`
        })
        .join('\n')
    }
    case 'codeBlock':
      return `\`\`\`${str(node.attrs?.['language'])}\n${(node.content ?? []).map((t) => t.text ?? '').join('')}\n\`\`\``
    case 'blockquote':
      return blocks(node.content, mediaMap)
        .split('\n')
        .map((line) => (line === '' ? '>' : `> ${line}`))
        .join('\n')
    case 'rule':
      return '---'
    case 'mediaSingle':
      return media(node, mediaMap) ?? embed(node)
    default:
      return embed(node)
  }
}

function blocks(nodes: AdfNode[] | undefined, mediaMap: MediaMap): string {
  return (nodes ?? [])
    .map((n) => block(n, mediaMap))
    .filter((b) => b !== undefined)
    .join('\n\n')
}

// Underline, colour, sub/superscript and alignment have no markdown form and are dropped (D61).
export function adfToMarkdown(
  doc: AdfDoc | null | undefined,
  mediaMap: MediaMap = new Map(),
): string {
  return blocks(doc?.content, mediaMap)
}

// Media ids of every image the document embeds, to decide whether a lookup is needed.
export function mediaIds(doc: AdfDoc | null | undefined): string[] {
  const ids: string[] = []
  const walk = (n: AdfNode): void => {
    if (n.type === 'media' && n.attrs?.['type'] === 'file') ids.push(String(n.attrs['id']))
    n.content?.forEach(walk)
  }
  doc?.content.forEach(walk)
  return ids
}

// ---- markdown -> ADF ----

const FENCE = /^\s*(```|~~~)/
const BLOCK_START = /^\s*([-+*]\s|\d+[.)]\s|#{1,6}\s|```|~~~|>|\||(-{3,}|\*{3,}|_{3,}|=+)\s*$)/

// People press Enter for a new line, so a single newline inside a paragraph becomes a
// markdown hard break (a trailing backslash). Code blocks and block starts are left alone.
function hardenLineBreaks(markdown: string): string {
  const lines = markdown.split('\n')
  let inFence = false
  return lines
    .map((line, i) => {
      if (FENCE.test(line)) inFence = !inFence
      const next = lines[i + 1]
      if (inFence || next === undefined || line.trim() === '' || next.trim() === '') return line
      if (/^\s*(#{1,6}\s|\||(-{3,}|\*{3,}|_{3,}|=+)\s*$)/.test(line) || FENCE.test(line))
        return line
      const quoted = /^\s*>/.test(line) && /^\s*>/.test(next)
      const nextContent = quoted ? next.replace(/^\s*>\s?/, '') : next
      if (nextContent.trim() === '' || (!quoted && BLOCK_START.test(next))) return line
      if (quoted && BLOCK_START.test(nextContent)) return line
      return line.endsWith('\\') ? line : `${line}\\`
    })
    .join('\n')
}

const PLACEHOLDER = /TASUKIEMBED(\d+)X/g

function isCode(node: AdfNode): boolean {
  return node.marks?.some((m) => m.type === 'code') ?? false
}

// Puts embedded nodes back where their placeholders sit; inside code they stay as written.
function restoreEmbeds(nodes: AdfNode[], embeds: string[], inCode: boolean): AdfNode[] {
  return nodes.flatMap((node): AdfNode[] => {
    if (node.type === 'text' && node.text !== undefined) {
      if (inCode || isCode(node))
        return [
          { ...node, text: node.text.replace(PLACEHOLDER, (_, i) => embeds[Number(i)] ?? '') },
        ]
      const out: AdfNode[] = []
      let last = 0
      for (const m of node.text.matchAll(PLACEHOLDER)) {
        if (m.index > last) out.push({ ...node, text: node.text.slice(last, m.index) })
        const token = embeds[Number(m[1])] ?? ''
        const [, , payload] = [...token.matchAll(EMBED_PATTERN)][0] ?? []
        out.push(payload === undefined ? { type: 'text', text: token } : decode(payload))
        last = m.index + m[0].length
      }
      if (last < node.text.length) out.push({ ...node, text: node.text.slice(last) })
      return out
    }
    if (!node.content) return [node]
    const content = restoreEmbeds(node.content, embeds, inCode || node.type === 'codeBlock')
    // A paragraph holding nothing but a block-level embed is that block again.
    if (node.type === 'paragraph' && content.length === 1 && !INLINE_TYPES.has(content[0]!.type))
      return [content[0]!]
    return [{ ...node, content }]
  })
}

async function resolveMedia(node: AdfNode, resolve: MediaResolver): Promise<AdfNode> {
  if (node.type === 'media' && node.attrs?.['type'] === 'external') {
    const url = str(node.attrs['url'])
    if (url.startsWith(ATTACHMENT_SCHEME)) {
      // No alt: Jira's renderer silently drops a media node that has one (D61), so the
      // image would vanish from the issue page. Reading back uses the attachment's filename.
      return {
        type: 'media',
        attrs: {
          type: 'file',
          id: await resolve(url.slice(ATTACHMENT_SCHEME.length)),
          collection: '',
        },
      }
    }
  }
  if (!node.content) return node
  return { ...node, content: await Promise.all(node.content.map((c) => resolveMedia(c, resolve))) }
}

export async function markdownToAdf(markdown: string, resolve: MediaResolver): Promise<AdfDoc> {
  const embeds: string[] = []
  const withPlaceholders = markdown.replace(EMBED_PATTERN, (token) => {
    embeds.push(token)
    return `TASUKIEMBED${embeds.length - 1}X`
  })
  const doc = parseMarkdown(hardenLineBreaks(withPlaceholders)) as AdfDoc
  const content = restoreEmbeds(doc.content, embeds, false)
  return {
    type: 'doc',
    version: 1,
    content: await Promise.all(content.map((n) => resolveMedia(n, resolve))),
  }
}
