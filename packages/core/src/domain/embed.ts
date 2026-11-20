// Content the tracker holds but markdown cannot express (a Jira mention, panel, table...).
// The tracker writes it into the body as a token carrying the original, and puts it back
// untouched on save, so editing in tasuki never drops it. Deleting the token deletes it.
// The label is what a person sees; the payload is opaque to everyone but that tracker.
export const EMBED_PATTERN: RegExp = /\[\[embed:([^|\]\n]*)\|([A-Za-z0-9+/=]+)\]\]/g

export function formatEmbed(label: string, payload: string): string {
  return `[[embed:${label.replace(/[|\]\n]/g, ' ')}|${payload}]]`
}
