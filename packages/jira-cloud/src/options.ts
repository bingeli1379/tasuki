export interface JiraOptions {
  baseUrl: string
  email: string
  apiToken: string
  project: string
  // Issue type ids, not names: names are translated per user locale (D50).
  issueTypes: { item: string }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '')
    throw new Error(`options.${path} must be a non-empty string`)
  return value
}

export function parseOptions(raw: unknown): JiraOptions {
  const o = (raw ?? {}) as Record<string, unknown>
  const types = (o['issueTypes'] ?? {}) as Record<string, unknown>
  return {
    baseUrl: requireString(o['baseUrl'], 'baseUrl').replace(/\/+$/, ''),
    email: requireString(o['email'], 'email'),
    apiToken: requireString(o['apiToken'], 'apiToken'),
    project: requireString(o['project'], 'project'),
    issueTypes: { item: requireString(types['item'], 'issueTypes.item') },
  }
}
