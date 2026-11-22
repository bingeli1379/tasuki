import { runDoctor } from '@tasuki/server'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vite-plus/test'
import { init } from './init'

// Each question takes the next answer, in the order init asks them. A select answer is the
// label of the option to pick; a multiselect answer lists labels.
const answers: unknown[] = []
const next = (): unknown => {
  if (answers.length === 0) throw new Error('asked more than the script answers')
  return answers.shift()
}
const pick = (opts: { options: { value: unknown; label: string }[] }, label: unknown) => {
  const found = opts.options.find((o) => o.label === label)
  if (found === undefined) throw new Error(`no option ${String(label)}`)
  return found.value
}
const CANCEL = Symbol('cancel')
vi.mock('@clack/prompts', () => ({
  isCancel: (v: unknown) => v === CANCEL,
  intro: () => {},
  outro: () => {},
  note: () => {},
  cancel: () => {},
  log: { info: () => {} },
  spinner: () => ({ start: () => {}, stop: () => {}, error: () => {} }),
  text: async () => next(),
  password: async () => next(),
  select: async (opts: { options: { value: unknown; label: string }[] }) => {
    const answer = next()
    return answer === CANCEL ? CANCEL : pick(opts, answer)
  },
  multiselect: async (opts: { options: { value: unknown; label: string }[] }) =>
    (next() as string[]).map((label) => pick(opts, label)),
}))
const scripted = (list: unknown[]): void => {
  answers.splice(0, answers.length, ...list)
}

const configIn = (): string =>
  join(mkdtempSync(join(tmpdir(), 'tasuki-init-')), 'tasuki.config.jsonc')
const clock = { now: () => new Date() }
vi.spyOn(console, 'log').mockImplementation(() => {})

describe('tasuki init', () => {
  it('writes a sqlite config that doctor passes', async () => {
    const config = configIn()
    scripted(['sqlite', ['fake'], 'none'])
    await init(config)
    expect(answers).toEqual([])
    expect(readFileSync(config, 'utf8')).toContain('"@tasuki/fake-runner"')
    expect(await runDoctor(config, clock)).toBe(0)
  })

  it('looks the Jira ids up, names them, and keeps the secrets in .env', async () => {
    const config = configIn()
    const json = (body: unknown, status = 200): Response => Response.json(body, { status })
    const fetchFn = vi.fn(async (url: string, req?: RequestInit) => {
      const auth = new Headers(req?.headers).get('Authorization')
      const path = new URL(url).pathname
      if (path === '/rest/api/3/myself')
        return auth === `Basic ${Buffer.from('me@x.io:right').toString('base64')}`
          ? json({})
          : json({}, 401)
      if (path === '/rest/api/3/project/KAN')
        return json({
          issueTypes: [
            { id: '10006', name: 'Epic', subtask: false, hierarchyLevel: 1 },
            { id: '10007', name: 'Subtask', subtask: true, hierarchyLevel: -1 },
            { id: '10008', name: 'Task', subtask: false, hierarchyLevel: 0 },
          ],
        })
      if (path === '/rest/api/3/issueLinkType')
        return json({
          issueLinkTypes: [
            { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
          ],
        })
      return json({}, 404)
    })
    scripted([
      'Jira Cloud',
      'https://x.atlassian.net/',
      'me@x.io',
      'wrong',
      'https://x.atlassian.net',
      'me@x.io',
      'right',
      'nope',
      'kan',
      'Task',
      'Subtask',
      ['claude', 'codex'],
      'auth-builtin',
    ])
    await init(config, fetchFn as unknown as typeof fetch)
    expect(answers).toEqual([])
    const text = readFileSync(config, 'utf8')
    expect(text).toContain('"project": "KAN"')
    expect(text).toContain('"item": "10008", // Task')
    expect(text).toContain('"task": "10007", // Subtask')
    expect(text).toContain('"dependencyLinkType": "10000", // Blocks')
    expect(text).toContain('"apiToken": "${JIRA_API_TOKEN}"')
    expect(text).not.toContain('right')
    expect(text).toContain('"@tasuki/auth-builtin"')
    expect(text).toContain('"@tasuki/codex-cli"')
    const env = join(config, '..', '.env')
    expect(readFileSync(env, 'utf8')).toBe('JIRA_EMAIL=me@x.io\nJIRA_API_TOKEN=right\n')
    expect(statSync(env).mode & 0o777).toBe(0o600)
  })

  it('writes nothing when cancelled', async () => {
    const config = configIn()
    scripted(['sqlite', ['fake'], CANCEL])
    await init(config)
    expect(existsSync(config)).toBe(false)
  })

  it('leaves an existing config alone', async () => {
    const config = configIn()
    writeFileSync(config, '{}')
    await expect(init(config)).rejects.toThrow('already exists')
    expect(readFileSync(config, 'utf8')).toBe('{}')
  })
})
