import { runDoctor } from '@tasuki/server'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  it('writes a config that doctor passes, the tracker left to the board (D105)', async () => {
    const config = configIn()
    scripted([['fake'], 'none', '8787'])
    await init(config)
    expect(answers).toEqual([])
    const text = readFileSync(config, 'utf8')
    expect(text).toContain('"@tasuki/fake-runner"')
    expect(text).not.toContain('"tracker"')
    expect(await runDoctor(config, clock)).toBe(0)
  })

  it('writes the port and the sign-in picked', async () => {
    const config = configIn()
    scripted([['claude', 'codex'], 'auth-builtin', '9000'])
    await init(config)
    const text = readFileSync(config, 'utf8')
    expect(text).toContain('"port": 9000')
    expect(text).toContain('"@tasuki/auth-builtin"')
    expect(text).toContain('"@tasuki/codex-cli"')
  })

  it('writes nothing when cancelled', async () => {
    const config = configIn()
    scripted([['fake'], CANCEL])
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
