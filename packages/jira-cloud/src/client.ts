import type { JiraOptions } from './options'

export class JiraHttpError extends Error {
  override name = 'JiraHttpError'
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

// Raw access for what JSON calls cannot do: uploads, downloads, reading a redirect.
// A 3xx comes back as is when the caller asked for redirect: 'manual'.
export type JiraFetch = (path: string, init?: RequestInit) => Promise<Response>

export type JiraRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>

// Jira has been seen to hang on a request (rendering a description that points an image
// at its own attachment URL); without a limit the board would hang with it.
const TIMEOUT_MS = 30_000

export function createFetch(options: JiraOptions): JiraFetch {
  const auth = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString('base64')}`
  return async (path, init = {}) => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', auth)
    if (!headers.has('Accept')) headers.set('Accept', 'application/json')
    const res = await fetch(`${options.baseUrl}/rest/api/3${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const redirect = init.redirect === 'manual' && res.status >= 300 && res.status < 400
    if (!res.ok && !redirect)
      throw new JiraHttpError(
        `Jira ${init.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`,
        res.status,
      )
    return res
  }
}

export function createClient(jiraFetch: JiraFetch): JiraRequest {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await jiraFetch(path, init)
    return (res.status === 204 ? undefined : await res.json()) as T
  }
}
