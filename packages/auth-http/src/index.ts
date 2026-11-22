import { API_VERSION, definePlugin, type AuthPort, type Plugin } from '@tasuki/core'

export interface HttpAuthOptions {
  url: string
  // Sent with every check, e.g. an API key the outside system wants; ${VAR} keeps it in .env.
  headers: Record<string, string>
  timeoutSeconds: number
}

export function parseOptions(raw: unknown): HttpAuthOptions {
  const o = (raw ?? {}) as Record<string, unknown>
  const url = o['url']
  if (typeof url !== 'string' || !/^https?:\/\//.test(url))
    throw new Error('options.url must be an http or https URL')
  const headers = o['headers'] ?? {}
  if (
    headers === null ||
    typeof headers !== 'object' ||
    Array.isArray(headers) ||
    Object.values(headers).some((v) => typeof v !== 'string')
  )
    throw new Error('options.headers must map header names to strings')
  const timeoutSeconds = o['timeoutSeconds'] ?? 10
  if (typeof timeoutSeconds !== 'number' || !(timeoutSeconds > 0))
    throw new Error('options.timeoutSeconds must be a positive number')
  return { url, headers: headers as Record<string, string>, timeoutSeconds }
}

// The login page's username and password go to the outside system, which answers who that is
// (security-and-auth.md). The password passes through tasuki, so nothing here logs a request.
export function createHttpAuth(options: HttpAuthOptions): AuthPort {
  return {
    async login(credentials) {
      let res: Response
      try {
        res = await fetch(options.url, {
          method: 'POST',
          headers: { ...options.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(credentials),
          signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
        })
      } catch (e) {
        throw new Error(
          `the sign-in service at ${options.url} did not answer: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        )
      }
      // A 4xx is the outside system saying no; anything else but 200 is it being broken, which
      // must not read as a wrong password.
      if (res.status >= 400 && res.status < 500) return undefined
      if (res.status !== 200)
        throw new Error(`the sign-in service at ${options.url} answered ${res.status}`)
      const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined
      const userId = body?.['userId']
      if (typeof userId !== 'string' || userId === '')
        throw new Error(`the sign-in service at ${options.url} answered 200 without a userId`)
      const displayName = body?.['displayName']
      return {
        userId,
        displayName:
          typeof displayName === 'string' && displayName !== ''
            ? displayName
            : credentials.username,
      }
    },
  }
}

const plugin: Plugin = definePlugin({
  name: '@tasuki/auth-http',
  apiVersion: API_VERSION,
  auth: (_ctx, options) => createHttpAuth(parseOptions(options)),
})

export default plugin
