// Plain text only, one paragraph per line. Markdown <-> ADF is still to be picked (plan.md).
interface AdfNode {
  type: string
  text?: string
  content?: AdfNode[]
}

export interface AdfDoc {
  type: 'doc'
  version: 1
  content: AdfNode[]
}

export function textToAdf(text: string): AdfDoc {
  return {
    type: 'doc',
    version: 1,
    content: text
      .split('\n')
      .map((line) =>
        line === ''
          ? { type: 'paragraph' }
          : { type: 'paragraph', content: [{ type: 'text', text: line }] },
      ),
  }
}

const textOf = (node: AdfNode): string => node.text ?? (node.content ?? []).map(textOf).join('')

export function adfToText(doc: AdfDoc | null | undefined): string {
  return (doc?.content ?? []).map(textOf).join('\n')
}
