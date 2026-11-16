import { describe, expect, it } from 'vite-plus/test'
import { parseJsonc } from './jsonc'

describe('parseJsonc', () => {
  it('drops line and block comments and trailing commas', () => {
    const text = `{
      // line
      "a": 1, /* block */
      "b": [1, 2,],
    }`
    expect(parseJsonc(text)).toEqual({ a: 1, b: [1, 2] })
  })

  it('leaves comment-like text and escaped quotes inside strings alone', () => {
    expect(parseJsonc('{ "url": "https://x/*y*/", "q": "say \\"hi\\" // ok" }')).toEqual({
      url: 'https://x/*y*/',
      q: 'say "hi" // ok',
    })
  })
})
