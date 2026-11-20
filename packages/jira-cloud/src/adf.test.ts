import { describe, expect, it } from 'vite-plus/test'
import { adfToMarkdown, markdownToAdf, mediaIds, type AdfDoc, type AdfNode } from './adf'

const noMedia = (): Promise<string> => Promise.reject(new Error('no media expected'))
const roundTrip = async (markdown: string): Promise<string> =>
  adfToMarkdown(await markdownToAdf(markdown, noMedia))
const doc = (...content: AdfNode[]): AdfDoc => ({ type: 'doc', version: 1, content })

describe('markdown <-> ADF', () => {
  it.each([
    ['a single newline is a line break', 'first line\nsecond line'],
    ['paragraphs', 'one\n\ntwo'],
    ['headings', '# One\n\n### Three'],
    ['inline marks', 'a **b** _c_ `d` ~~e~~ [f](https://x.y) **_g_**'],
    ['lists, nested', '- one\n- two\n  1. nested\n  2. again\n- three'],
    ['a list item spanning lines', '- one\n  still one'],
    ['code keeps its text and language', '```ts\nconst a = 1\n\nconst b = "*x*"\n```'],
    ['a quote over two lines', '> first\n> second'],
    ['a rule', 'above\n\n---\n\nbelow'],
    ['snake_case is not escaped', 'set max_attempts to 3'],
    ['characters markdown would read are escaped', 'a \\*not bold\\* and 1\\[2\\]'],
    ['a line that would start a list stays text', '\\- not a list\n1\\. nor this'],
  ])('%s', async (_, markdown) => {
    expect(await roundTrip(markdown)).toBe(markdown)
  })

  it('an image of an attachment becomes a Jira media node and comes back', async () => {
    const adf = await markdownToAdf('see\n\n![shot.png](attachment:7)', (id) =>
      Promise.resolve(`media-${id}`),
    )
    expect(adf.content[1]).toEqual({
      type: 'mediaSingle',
      attrs: { layout: 'center' },
      content: [{ type: 'media', attrs: { type: 'file', id: 'media-7', collection: '' } }],
    })
    expect(mediaIds(adf)).toEqual(['media-7'])
    expect(adfToMarkdown(adf, new Map([['media-7', { id: '7', filename: 'shot.png' }]]))).toBe(
      'see\n\n![shot.png](attachment:7)',
    )
  })

  it('an image Jira wrote without alt text takes the attachment filename', () => {
    const adf = doc({
      type: 'mediaSingle',
      content: [{ type: 'media', attrs: { type: 'file', id: 'm', collection: '' } }],
    })
    expect(adfToMarkdown(adf, new Map([['m', { id: '9', filename: 'a.png' }]]))).toBe(
      '![a.png](attachment:9)',
    )
  })

  it('what markdown cannot say survives a round trip untouched', async () => {
    const mention: AdfNode = { type: 'mention', attrs: { id: 'acc-1', text: '@Eli' } }
    const table: AdfNode = {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
            },
          ],
        },
      ],
    }
    const unknownImage: AdfNode = {
      type: 'mediaSingle',
      content: [{ type: 'media', attrs: { type: 'file', id: 'not-mapped', collection: '' } }],
    }
    const original = doc(
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'hi ' }, mention, { type: 'text', text: '!' }],
      },
      table,
      unknownImage,
    )

    const markdown = adfToMarkdown(original)
    expect(markdown).toMatch(/^hi \[\[embed:@Eli\|[A-Za-z0-9+/=]+\]\]!\n\n\[\[embed:table\|/)

    const edited = `${markdown}\n\nadded`
    const back = await markdownToAdf(edited, noMedia)
    expect(back.content).toEqual([
      ...original.content,
      { type: 'paragraph', content: [{ type: 'text', text: 'added' }] },
    ])
  })

  it('an embed token inside code is left as written', async () => {
    const token = adfToMarkdown(
      doc({ type: 'paragraph', content: [{ type: 'mention', attrs: { text: 'x' } }] }),
    )
    const back = await markdownToAdf(`\`${token}\``, noMedia)
    expect(back.content[0]?.content?.[0]).toMatchObject({ type: 'text', text: token })
  })

  it('formatting markdown has no form for is dropped, the text kept', () => {
    const adf = doc({
      type: 'paragraph',
      content: [{ type: 'text', text: 'under', marks: [{ type: 'underline' }] }],
    })
    expect(adfToMarkdown(adf)).toBe('under')
  })

  it('reads a missing description as empty, and skips empty paragraphs', () => {
    expect(adfToMarkdown(null)).toBe('')
    expect(
      adfToMarkdown(
        doc(
          { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
          { type: 'paragraph' },
          { type: 'paragraph', content: [{ type: 'text', text: 'third' }] },
        ),
      ),
    ).toBe('first\n\nthird')
  })
})
