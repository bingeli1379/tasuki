import { createStatusMap, type RunnerPort, type RunSpec } from '@tasuki/core'
import { describeRunnerContract } from '@tasuki/testkit'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import plugin from './index'

// Stands in for the codex CLI: records how it was started and what came on stdin, then does
// what FAKE says. Events are the ones codex-cli 0.169.0 prints with --json.
const STAND_IN = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const args = process.argv.slice(2)
let stdin = ''
process.stdin.on('data', (c) => (stdin += c))
process.stdin.on('end', () => {
  appendFileSync(process.env.FAKE_OUT, JSON.stringify({ args, env: process.env, cwd: process.cwd(), stdin }) + '\\n')
  if (args.includes('--version')) return console.log('codex-cli 0.169.0')
  const resume = args.indexOf('resume')
  if (process.env.FAKE === 'no-session' && resume !== -1) {
    console.error('Error: thread/resume: thread/resume failed: no rollout found for thread id ' + args[resume + 1] + ' (code -32600)')
    process.exit(1)
  }
  console.log(JSON.stringify({ type: 'thread.started', thread_id: resume === -1 ? randomUUID() : args[resume + 1] }))
  console.log(JSON.stringify({ type: 'turn.started' }))
  if (process.env.FAKE === 'hang') {
    const child = spawn('sleep', ['1000'], { stdio: 'ignore' })
    writeFileSync(process.env.FAKE_OUT + '.child', String(child.pid))
    setInterval(() => {}, 1000)
    return
  }
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'done' } }))
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }))
})
`

const ctx = {
  clock: { now: () => new Date() },
  configDir: '',
  dataDir: '',
  statuses: createStatusMap({}),
}

function setup(fake = '', extra: Record<string, unknown> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tasuki-codex-')))
  const command = join(dir, 'codex')
  writeFileSync(command, STAND_IN.replace('/usr/bin/env node', process.execPath))
  chmodSync(command, 0o755)
  const out = join(dir, 'out.jsonl')
  const runner = plugin.runner?.(ctx, {
    command,
    ...extra,
    env: { FAKE: fake, FAKE_OUT: out, ...(extra['env'] as object | undefined) },
  }) as RunnerPort
  const sessions: string[] = []
  const spec = (more: Partial<RunSpec> = {}): RunSpec => ({
    runId: 'run-1',
    target: 'T-1',
    workspace: dir,
    mcp: { url: 'http://127.0.0.1:8787/agent-mcp', token: 'secret-token' },
    prompt: 'Split T-1.',
    logPath: join(dir, 'run.log'),
    onActivity: () => {},
    onSession: (id) => sessions.push(id),
    ...more,
  })
  const calls = (): { args: string[]; env: Record<string, string>; cwd: string; stdin: string }[] =>
    readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as ReturnType<typeof calls>[number])
  return { dir, runner, spec, calls, sessions }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('codex-cli runner', () => {
  it('runs codex exec in the workspace with the prompt on stdin, the facade and no machine config', async () => {
    const t = setup()
    await t.runner.start(t.spec()).exit
    const [call] = t.calls()
    expect(call?.cwd).toBe(t.dir)
    expect(call?.stdin).toBe('Split T-1.')
    expect(call?.args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(call?.args.at(-1)).toBe('-')
    const args = call?.args.join(' ') ?? ''
    expect(args).toContain(`--cd ${t.dir}`)
    expect(args).toContain('--sandbox workspace-write')
    expect(args).toContain('--ignore-user-config --ignore-rules')
    expect(args).toContain('approval_policy="never"')
    expect(args).toContain('mcp_servers.tasuki.url="http://127.0.0.1:8787/agent-mcp"')
    expect(args).toContain('mcp_servers.tasuki.bearer_token_env_var="TASUKI_MCP_TOKEN"')
    expect(args).not.toContain('secret-token')
    expect(call?.env['TASUKI_MCP_TOKEN']).toBe('secret-token')
  })

  it('reports the thread codex started as the session, and resumes the one it is given', async () => {
    const t = setup()
    await t.runner.start(t.spec()).exit
    const first = t.sessions[0]
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    await t.runner.start(t.spec({ resume: first as string })).exit
    const resumed = t.calls()[1]?.args ?? []
    expect(resumed.slice(resumed.indexOf('resume'))).toEqual(['resume', first, '-'])
    expect(t.sessions[1]).toBe(first)
  })

  it("hands the agent its Run and options.env, never the engine's own secrets", async () => {
    process.env['JIRA_API_TOKEN'] = 'tracker-secret'
    try {
      const t = setup('', { model: 'gpt-5', inheritSettings: true })
      await t.runner.start(t.spec()).exit
      const [call] = t.calls()
      expect(call?.env).toMatchObject({ TASUKI_RUN_ID: 'run-1', TASUKI_TARGET: 'T-1' })
      expect(call?.env['JIRA_API_TOKEN']).toBeUndefined()
      const args = call?.args.join(' ') ?? ''
      expect(args).toContain('--model gpt-5')
      expect(args).not.toContain('--ignore-user-config')
    } finally {
      delete process.env['JIRA_API_TOKEN']
    }
  })

  it.each([
    ['auto', ['--approve-for-me'], ['--sandbox', 'approval_policy']],
    ['bypass', ['--dangerously-bypass-approvals-and-sandbox'], ['--sandbox', 'approval_policy']],
  ])('permissions %s passes %j and none of %j', async (permissions, has, hasNot) => {
    const t = setup('', { permissions })
    await t.runner.start(t.spec()).exit
    const args = t.calls()[0]?.args.join(' ') ?? ''
    for (const a of has) expect(args).toContain(a)
    for (const a of hasNot) expect(args).not.toContain(a)
  })

  it("puts the agent's base prompt after the engine's, and drops an API key it is not signed in with", async () => {
    const t = setup('', { appendSystemPrompt: 'Commit when done.' })
    await t.runner.start(t.spec()).exit
    expect(t.calls()[0]?.stdin).toBe('Split T-1.\n\nCommit when done.')
    const kept = setup('', { env: { CODEX_API_KEY: 'k' } })
    await kept.runner.start(kept.spec()).exit
    expect(kept.calls()[0]?.env['CODEX_API_KEY']).toBeUndefined()
  })

  it('ends the whole process tree on terminate', async () => {
    const t = setup('hang')
    const handle = t.runner.start(t.spec())
    const out = join(t.dir, 'out.jsonl.child')
    let child = 0
    for (let i = 0; i < 100 && child === 0; i++) {
      await new Promise((r) => setTimeout(r, 50))
      child = Number(readFileSync(out, { encoding: 'utf8', flag: 'a+' }) || 0)
    }
    expect(alive(child)).toBe(true)
    handle.terminate('SIGTERM')
    expect(await handle.exit).toEqual({ code: null, signal: 'SIGTERM' })
    await new Promise((r) => setTimeout(r, 100))
    expect(alive(child)).toBe(false)
  })

  it('refuses options it cannot honour', () => {
    const make = (options: unknown) => () => plugin.runner?.(ctx, options)
    expect(make({ auth: 'oauth-token' })).toThrow('options.auth must be inherit-login or api-key')
    expect(make({ auth: 'api-key' })).toThrow('needs options.env.CODEX_API_KEY')
    expect(make({ auth: 'api-key', env: { CODEX_API_KEY: 'k' } })).not.toThrow()
    expect(make({ allowedTools: ['Read'] })).toThrow('set options.permissions')
    expect(make({ requires: { skills: ['x'] } })).toThrow('options.requires')
    expect(make({ permissions: 'open' })).toThrow('options.permissions must be')
    expect(make({ env: { A: 1 } })).toThrow('options.env must map names to strings')
  })
})

describe('codex-cli doctor', () => {
  it('passes a CLI that runs, and names one that does not', async () => {
    expect(await setup().runner.doctor?.()).toEqual([])
    const missing = plugin.runner?.(ctx, { command: '/nowhere/codex' }) as RunnerPort
    expect((await missing.doctor?.())?.[0]?.message).toContain('/nowhere/codex does not run')
  })
})

describeRunnerContract('codex-cli', async () => ({
  runner: (behavior) => setup(behavior === 'succeed' ? '' : behavior).runner,
  missing: () => plugin.runner?.(ctx, { command: '/nowhere/codex' }) as RunnerPort,
}))
