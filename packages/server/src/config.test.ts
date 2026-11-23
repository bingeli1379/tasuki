import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { loadConfig } from './config'

const write = (config: string, env?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'tasuki-config-'))
  writeFileSync(join(dir, 'tasuki.config.jsonc'), config)
  if (env !== undefined) writeFileSync(join(dir, '.env'), env)
  return join(dir, 'tasuki.config.jsonc')
}

const ENV = ['TASUKI_DATA_DIR', 'TASUKI_HOST', 'TASUKI_PORT', 'TASUKI_PUBLIC_URL']

describe('loadConfig', () => {
  afterEach(() => {
    for (const name of ENV) delete process.env[name]
  })

  it('defaults to the sqlite tracker and store, and keeps the data in ~/.tasuki', () => {
    const config = loadConfig(write('{ "version": 1, }'))
    expect(config.tracker).toEqual({ plugin: '@tasuki/sqlite', options: {} })
    expect(config.store).toEqual({ plugin: '@tasuki/sqlite', options: {} })
    expect(config.dataDir).toBe(join(homedir(), '.tasuki'))
  })

  it('resolves dataDir against the config folder', () => {
    const config = loadConfig(write('{ "dataDir": "./data" }'))
    expect(config.dataDir).toBe(join(config.configDir, 'data'))
  })

  it('needs no file: with none in the working folder it runs on the defaults (D105)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'tasuki-config-'))
    const config = loadConfig(undefined, empty)
    expect(config).toMatchObject({ configDir: empty, host: '127.0.0.1', port: 8787, agents: {} })
    expect(config.auth).toBeUndefined()
  })

  it('takes tasuki.config.jsonc in the working folder when no --config is given', () => {
    const path = write('{ "server": { "port": 9000 } }')
    expect(loadConfig(undefined, join(path, '..')).port).toBe(9000)
  })

  it('refuses a --config that does not exist', () => {
    expect(() => loadConfig('missing.jsonc', tmpdir())).toThrow('config file not found')
  })

  it('takes dataDir, host, port and publicUrl from the environment over the file', () => {
    process.env['TASUKI_DATA_DIR'] = '/srv/tasuki'
    process.env['TASUKI_PORT'] = '9100'
    process.env['TASUKI_HOST'] = '0.0.0.0'
    process.env['TASUKI_PUBLIC_URL'] = 'https://tasuki.example.com/'
    const config = loadConfig(
      write(
        '{ "dataDir": "./data", "server": { "port": 9000 }, "auth": { "plugin": "@tasuki/auth-builtin" } }',
      ),
    )
    expect(config).toMatchObject({
      dataDir: '/srv/tasuki',
      port: 9100,
      host: '0.0.0.0',
      publicUrl: 'https://tasuki.example.com',
    })
  })

  it('refuses a port that is not one', () => {
    process.env['TASUKI_PORT'] = 'eighty'
    expect(() => loadConfig(write('{}'))).toThrow('TASUKI_PORT must be a port number')
  })

  it('has no auth unless one is set, and a session lasts 7 days by default', () => {
    expect(loadConfig(write('{}')).auth).toBeUndefined()
    const auth = loadConfig(write('{ "auth": { "plugin": "@tasuki/auth-builtin" } }')).auth
    expect(auth).toEqual({
      plugin: '@tasuki/auth-builtin',
      options: {},
      ttl: '7d',
      ttlSeconds: 7 * 86400,
    })
  })

  it('takes a ttl in minutes, hours or days, or never, and nothing else', () => {
    const ttl = (value: string) =>
      loadConfig(write(JSON.stringify({ auth: { plugin: 'x', session: { ttl: value } } }))).auth
    expect(ttl('90m')?.ttlSeconds).toBe(5400)
    expect(ttl('24h')?.ttlSeconds).toBe(86400)
    expect(ttl('never')).toEqual({ plugin: 'x', options: {}, ttl: 'never' })
    for (const bad of ['7', '0d', '1w', '1.5h'])
      expect(() => ttl(bad)).toThrow('config auth.session.ttl')
  })

  it('binds loopback unless told otherwise, and off loopback needs auth and an https publicUrl', () => {
    const server = (s: object, auth = true) =>
      loadConfig(
        write(
          JSON.stringify({ server: s, ...(auth ? { auth: { plugin: '@tasuki/auth-http' } } : {}) }),
        ),
      )
    expect(server({}, false)).toMatchObject({ host: '127.0.0.1' })
    expect(server({}, false).publicUrl).toBeUndefined()
    expect(() => server({ host: '0.0.0.0' }, false)).toThrow('with no auth')
    expect(() => server({ host: '0.0.0.0' })).toThrow('config server.publicUrl must be the https')
    expect(() => server({ host: '0.0.0.0', publicUrl: 'http://tasuki.example' })).toThrow(
      'config server.publicUrl must be the https',
    )
    expect(() => server({ host: '0.0.0.0', publicUrl: 'not a url' })).toThrow(
      'config server.publicUrl must be a URL',
    )
    expect(server({ host: '0.0.0.0', publicUrl: 'https://tasuki.example/' })).toMatchObject({
      host: '0.0.0.0',
      publicUrl: 'https://tasuki.example',
    })
    // A container publishing its port on the host's loopback only (D90).
    expect(server({ host: '0.0.0.0', allowInsecure: true }, false)).toMatchObject({
      host: '0.0.0.0',
    })
    expect(server({ host: '::1' }, false).host).toBe('::1')
  })

  it('expands ${VAR} from a .env next to the config', () => {
    const path = write(
      '{ "tracker": { "plugin": "x", "options": { "token": "${TASUKI_TEST_TOKEN}" } } }',
      'TASUKI_TEST_TOKEN=from-env-file\n',
    )
    expect(loadConfig(path).tracker.options).toEqual({ token: 'from-env-file' })
  })

  it('names the variable and where it is used when it is missing', () => {
    const path = write(
      '{ "tracker": { "plugin": "x", "options": { "token": "${TASUKI_TEST_MISSING}" } } }',
    )
    expect(() => loadConfig(path)).toThrow(
      'config tracker.options.token: environment variable TASUKI_TEST_MISSING is not set',
    )
  })

  it('reads agents', () => {
    const config = loadConfig(
      write(
        JSON.stringify({
          agents: { fake: { plugin: '@tasuki/fake-runner', options: { seconds: 1 } } },
        }),
      ),
    )
    expect(config.agents).toEqual({
      fake: { plugin: '@tasuki/fake-runner', options: { seconds: 1 } },
    })
  })

  it('refuses a field it does not hold, the ones in the store included (D91, D105)', () => {
    for (const field of ['workflow', 'rules', 'labels', 'statuses', 'poll', 'limits', 'workspace'])
      expect(() => loadConfig(write(JSON.stringify({ [field]: {} })))).toThrow(
        `config ${field}: not a field of the config file`,
      )
  })
})
