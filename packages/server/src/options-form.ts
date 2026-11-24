import type { OptionsForm } from '@tasuki/core'

// Plugin options as the settings pages edit them: fields named by dot paths, secrets sealed
// in the store and never sent back (D106, D111).

export type Raw = Record<string, unknown>

export const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function getPath(options: Raw, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((at, part) => (isObject(at) ? at[part] : undefined), options)
}

// A copy with the value at key set, or removed when value is undefined.
export function setPath(options: Raw, key: string, value: unknown): Raw {
  const [head, ...rest] = key.split('.') as [string, ...string[]]
  const copy = { ...options }
  // Removing under a parent that is not there leaves it out rather than making an empty one.
  if (value === undefined && rest.length > 0 && !isObject(copy[head])) return copy
  if (rest.length === 0) {
    if (value === undefined) delete copy[head]
    else copy[head] = value
    return copy
  }
  copy[head] = setPath(isObject(copy[head]) ? copy[head] : {}, rest.join('.'), value)
  return copy
}

export const secretKeys = (form: OptionsForm | undefined): string[] =>
  (form?.fields ?? []).filter((f) => f.type === 'secret').map((f) => f.key)

export function mapSecrets(options: Raw, keys: string[], map: (v: string) => string): Raw {
  let out = options
  for (const key of keys) {
    const v = getPath(options, key)
    if (typeof v === 'string' && v !== '') out = setPath(out, key, map(v))
  }
  return out
}

export function withoutSecrets(options: Raw, keys: string[]): Raw {
  let out = options
  for (const key of keys) out = setPath(out, key, undefined)
  return out
}

// A secret left blank keeps the one saved before, when there is one to keep.
export function keepSecrets(options: Raw, keys: string[], before: Raw | undefined): Raw {
  let out = options
  if (before === undefined) return out
  for (const key of keys) {
    const v = getPath(options, key)
    const kept = getPath(before, key)
    if ((v === undefined || v === '') && kept !== undefined) out = setPath(out, key, kept)
  }
  return out
}

// The same options whatever order their keys came in, as JSON from the page or the store.
export function sameOptions(a: unknown, b: unknown): boolean {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : isObject(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted(v[k])]),
          )
        : v
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
}

export function checkRequired(options: Raw, form: OptionsForm | undefined): string | undefined {
  for (const field of form?.fields ?? []) {
    const v = getPath(options, field.key)
    if (field.required === true && (v === undefined || v === ''))
      return `${field.label} is required`
  }
  return undefined
}
