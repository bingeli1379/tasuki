import { ATTACHMENT_SCHEME, EMBED_PATTERN } from '@tasuki/core'
import MarkdownIt from 'markdown-it'
import { attachmentUrl } from './api'

// html: false escapes any HTML in a ticket, and markdown-it refuses javascript: links, so
// the output is safe for v-html. linkify stays off: it would split an embed token whose
// label is a URL. breaks: a single newline is a line break, as trackers store it.
const md = new MarkdownIt({ html: false, linkify: false, breaks: true })

const renderImage = md.renderer.rules.image!
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!
  const src = String(token.attrGet('src') ?? '')
  if (src.startsWith(ATTACHMENT_SCHEME))
    token.attrSet(
      'src',
      attachmentUrl((env as { ref: string }).ref, src.slice(ATTACHMENT_SCHEME.length)),
    )
  return renderImage(tokens, idx, options, env, self)
}

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  tokens[idx]!.attrSet('target', '_blank')
  tokens[idx]!.attrSet('rel', 'noopener noreferrer')
  return self.renderToken(tokens, idx, options)
}

// Content the tracker keeps but markdown cannot show (a Jira mention, a table) is a chip.
// The label was escaped by markdown-it along with the rest of the text.
export function renderMarkdown(source: string, ref: string): string {
  return md
    .render(source, { ref })
    .replace(
      EMBED_PATTERN,
      (_, label: string) =>
        `<span class="embed" title="Kept from the tracker; edit it there">${label}</span>`,
    )
}

// The words of a body without its markup, for the card preview.
export function previewText(source: string): string {
  return md
    .parse(source, {})
    .filter((t) => t.type === 'inline')
    .map((t) =>
      (t.children ?? [])
        .map((c) =>
          c.type === 'text' || c.type === 'code_inline'
            ? c.content
            : c.type === 'softbreak' || c.type === 'hardbreak'
              ? ' '
              : '',
        )
        .join(''),
    )
    .join(' ')
    .replace(EMBED_PATTERN, (_, label: string) => label)
}
