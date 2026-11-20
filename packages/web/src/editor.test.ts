import { describe, expect, it } from 'vite-plus/test'
import { toStoredMarkdown } from './editor'

describe('toStoredMarkdown', () => {
  it('turns the editor line break back into a plain newline', () => {
    expect(toStoredMarkdown('first  \nsecond')).toBe('first\nsecond')
  })

  it('unescapes an underscore inside a word, nowhere else', () => {
    expect(toStoredMarkdown('set max\\_attempts and \\_not\\_ this')).toBe(
      'set max_attempts and \\_not\\_ this',
    )
  })

  it('leaves code alone', () => {
    const fenced = '```\nconst a\\_b = 1  \n```'
    expect(toStoredMarkdown(fenced)).toBe(fenced)
    expect(toStoredMarkdown('`a\\_b` and a\\_b')).toBe('`a\\_b` and a_b')
  })
})
