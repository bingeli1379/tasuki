import { describe, expect, it } from 'vite-plus/test'
import { adfToText, textToAdf } from './adf'

describe('adf', () => {
  it('round-trips plain text line by line, blank lines included', () => {
    const text = 'first\n\nthird'
    expect(adfToText(textToAdf(text))).toBe(text)
  })

  it('reads a missing description as empty', () => {
    expect(adfToText(null)).toBe('')
  })
})
