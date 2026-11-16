import type { JiraOptions } from './options'

export type JiraRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>

export function createClient(options: JiraOptions): JiraRequest {
  const auth = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString('base64')}`
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await fetch(`${options.baseUrl}/rest/api/3${path}`, init)
    if (!res.ok) throw new Error(`Jira ${method} ${path} failed: ${res.status} ${await res.text()}`)
    return (res.status === 204 ? undefined : await res.json()) as T
  }
}
