// A plugin's options as the settings forms edit them: one string per field, keyed by its dot
// path, turned back into the nested options the plugin reads on save (D111).

export interface OptionField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'secret' | 'select' | 'list' | 'json'
  required?: boolean
  description?: string
  placeholder?: string
  choices?: { value: string; label: string }[]
}

const getPath = (options: Record<string, unknown>, key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (at, part) =>
        at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[part] : undefined,
      options,
    )

export function toValues(
  fields: OptionField[],
  options: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    fields.map((f) => {
      const v = getPath(options, f.key)
      if (v === undefined) return [f.key, '']
      if (f.type === 'list') return [f.key, Array.isArray(v) ? v.join('\n') : '']
      if (f.type === 'json') return [f.key, JSON.stringify(v, null, 2)]
      return [f.key, typeof v === 'string' ? v : '']
    }),
  )
}

// Back to the nested shape the plugin reads: issueTypes.item -> { issueTypes: { item } }.
// kept: the options as saved, whose keys the form does not show are sent back as they were,
// so a save from the page never drops them. Throws, naming the field, on JSON that does not
// parse.
export function toOptions(
  fields: OptionField[],
  values: Record<string, string>,
  kept: Record<string, unknown> = {},
): Record<string, unknown> {
  // A JSON copy: kept is often a Vue proxy, which structuredClone refuses.
  const out = JSON.parse(JSON.stringify(kept)) as Record<string, unknown>
  for (const f of fields) {
    const parts = f.key.split('.')
    const parent = parts
      .slice(0, -1)
      .reduce<unknown>(
        (at, part) =>
          at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[part] : undefined,
        out,
      )
    if (parent !== null && typeof parent === 'object')
      delete (parent as Record<string, unknown>)[parts.at(-1) ?? f.key]
  }
  for (const f of fields) {
    const text = values[f.key] ?? ''
    if (text.trim() === '') continue
    let value: unknown = text
    if (f.type === 'list')
      value = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
    else if (f.type === 'json')
      try {
        value = JSON.parse(text)
      } catch {
        throw new Error(`${f.label} is not valid JSON`)
      }
    const parts = f.key.split('.')
    let at = out
    for (const part of parts.slice(0, -1)) at = (at[part] ??= {}) as Record<string, unknown>
    at[parts.at(-1) ?? f.key] = value
  }
  return out
}
