import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { loadConfig } from './config'

const write = (config: string, env?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'tasuki-config-'))
  writeFileSync(join(dir, 'tasuki.config.jsonc'), config)
  if (env !== undefined) writeFileSync(join(dir, '.env'), env)
  return join(dir, 'tasuki.config.jsonc')
}

describe('loadConfig', () => {
  it('defaults to the sqlite tracker and resolves dataDir against the config folder', () => {
    const path = write('{ "version": 1, }')
    const config = loadConfig(path)
    expect(config.tracker).toEqual({ plugin: '@tasuki/sqlite', options: {} })
    expect(config.dataDir).toBe(join(config.configDir, 'data'))
    expect(config.statuses.item?.['refining']).toBe('Refining')
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

  it('refuses a mapping without refining, or with a status that does not exist', () => {
    expect(() => loadConfig(write('{ "statuses": { "item": { "done": "Done" } } }'))).toThrow(
      'must map refining',
    )
    expect(() =>
      loadConfig(write('{ "statuses": { "item": { "refining": "R", "doing": "D" } } }')),
    ).toThrow('unknown status doing')
  })
})
