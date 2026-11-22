import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { createHttpAuth, parseOptions } from './index'

let close: (() => void) | undefined
afterEach(() => close?.())

async function service(
  answer: (req: IncomingMessage, body: string, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => answer(req, body, res))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  close = () => server.close()
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/check`
}

const reply = (res: ServerResponse, status: number, body?: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

describe('auth-http', () => {
  it('posts the credentials with the configured headers and takes who the service says it is', async () => {
    let seen: { body: string; key: string | undefined } | undefined
    const url = await service((req, body, res) => {
      seen = { body, key: req.headers['x-api-key'] as string | undefined }
      reply(res, 200, { userId: 'u-42', displayName: 'Eli Ye' })
    })
    const auth = createHttpAuth(parseOptions({ url, headers: { 'X-Api-Key': 'k' } }))
    expect(await auth.login({ username: 'eli', password: 'pw' })).toEqual({
      userId: 'u-42',
      displayName: 'Eli Ye',
    })
    expect(seen).toEqual({ body: JSON.stringify({ username: 'eli', password: 'pw' }), key: 'k' })
    expect(auth.accounts).toBeUndefined()
  })

  it('reads a 4xx as wrong credentials and falls back to the username for a missing name', async () => {
    const url = await service((_req, body, res) =>
      JSON.parse(body).password === 'pw' ? reply(res, 200, { userId: 'u-1' }) : reply(res, 401),
    )
    const auth = createHttpAuth(parseOptions({ url }))
    expect(await auth.login({ username: 'eli', password: 'nope' })).toBeUndefined()
    expect(await auth.login({ username: 'eli', password: 'pw' })).toEqual({
      userId: 'u-1',
      displayName: 'eli',
    })
  })

  it('throws, never answering a wrong password, when the service is broken or slow', async () => {
    const broken = await service((_req, _body, res) => reply(res, 503))
    await expect(
      createHttpAuth(parseOptions({ url: broken })).login({ username: 'a', password: 'b' }),
    ).rejects.toThrow('answered 503')
    close?.()
    const slow = await service(() => {})
    await expect(
      createHttpAuth(parseOptions({ url: slow, timeoutSeconds: 0.2 })).login({
        username: 'a',
        password: 'b',
      }),
    ).rejects.toThrow('did not answer')
  })

  it('needs a url, and checks headers and timeout when given', () => {
    expect(() => parseOptions({})).toThrow('options.url')
    expect(() => parseOptions({ url: 'ftp://x' })).toThrow('options.url')
    expect(() => parseOptions({ url: 'https://x', headers: { a: 1 } })).toThrow('options.headers')
    expect(() => parseOptions({ url: 'https://x', timeoutSeconds: 0 })).toThrow(
      'options.timeoutSeconds',
    )
    expect(parseOptions({ url: 'https://x' })).toEqual({
      url: 'https://x',
      headers: {},
      timeoutSeconds: 10,
    })
  })
})
