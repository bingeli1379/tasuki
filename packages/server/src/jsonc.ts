// Comments and trailing commas, nothing else. Enough for tasuki.config.jsonc without a dependency.
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '"') {
      const start = i
      i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      out += text.slice(start, ++i)
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      out += ch
      i++
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}
