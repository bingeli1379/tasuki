import {
  createStatusMap,
  DEFAULT_WORKFLOW,
  TASK_STATUS_DISPLAY,
  type RunExit,
  type RunnerPort,
  type RunSpec,
} from '@tasuki/core'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vite-plus/test'
import plugin from './index'

// Stands in for the claude CLI: records how it was started, then does what FAKE says.
// no-session: refuses any --resume the way claude does. hang: starts a child of its own and
// waits, so terminate has a process tree to end.
const STAND_IN = `#!/usr/bin/env node
const { writeFileSync, appendFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_OUT, JSON.stringify({ args, env: process.env, cwd: process.cwd() }) + '\\n')
if (process.env.FAKE === 'no-session' && args.includes('--resume')) {
  console.error('No conversation found with session ID: ' + args[args.indexOf('--resume') + 1])
  process.exit(1)
}
if (process.env.FAKE === 'init' && !args.includes('--version')) {
  console.log(JSON.stringify({ type: 'system', subtype: 'ui_status' }))
  console.log(JSON.stringify({
    type: 'system',
    subtype: 'init',
    mcp_servers: [{ name: 'gitlab', status: 'connected' }, { name: 'jira', status: 'needs-auth' }],
    skills: ['sdd:apply'],
  }))
  setInterval(() => {}, 1000)
} else if (process.env.FAKE === 'hang') {
  const child = spawn('sleep', ['1000'], { stdio: 'ignore' })
  writeFileSync(process.env.FAKE_OUT + '.child', String(child.pid))
  setInterval(() => {}, 1000)
} else {
  console.log(JSON.stringify({ type: 'result', subtype: 'success' }))
}
`

function setup(fake = '', extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tasuki-claude-'))
  const command = join(dir, 'claude')
  writeFileSync(command, STAND_IN.replace('/usr/bin/env node', process.execPath))
  chmodSync(command, 0o755)
  // A plugin folder and a base prompt for the options that point at files.
  mkdirSync(join(dir, 'sdd'))
  writeFileSync(join(dir, 'base.md'), 'Commit and push when done.')
  const out = join(dir, 'out.jsonl')
  const runner = plugin.runner?.(
    {
      clock: { now: () => new Date() },
      configDir: dir,
      dataDir: dir,
      statuses: createStatusMap({
        item: Object.fromEntries(DEFAULT_WORKFLOW.statuses.map((s) => [s.id, s.name])),
        task: TASK_STATUS_DISPLAY,
      }),
    },
    { command, env: { FAKE: fake, FAKE_OUT: out }, ...extra },
  ) as RunnerPort
  const sessions: string[] = []
  let activity = 0
  const spec = (more: Partial<RunSpec> = {}): RunSpec => ({
    runId: 'run-1',
    target: 'T-1',
    mode: 'split',
    workspace: dir,
    mcp: { url: 'http://127.0.0.1:8787/agent-mcp', token: 'secret-token' },
    prompt: 'Split T-1.',
    logPath: join(dir, 'run.log'),
    onActivity: () => activity++,
    onSession: (id) => sessions.push(id),
    ...more,
  })
  const calls = (): { args: string[]; env: Record<string, string>; cwd: string }[] =>
    readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { args: string[]; env: Record<string, string>; cwd: string })
  const arg = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1]
  return {
    dir,
    out,
    runner,
    spec,
    calls,
    arg,
    sessions,
    activity: () => activity,
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('claude-cli runner', () => {
  it('runs claude headless in the workspace with the prompt, the facade and nothing else allowed', async () => {
    const t = setup('', { allowedTools: ['Read', 'Bash(git:*)'], model: 'haiku' })
    const exit = await t.runner.start(t.spec()).exit
    expect(exit).toEqual<RunExit>({ code: 0, signal: null })
    const [call] = t.calls()
    const args = call?.args ?? []
    // macOS tmpdir sits behind a symlink; the CLI reports the real path.
    expect(call?.cwd).toBe(realpathSync(t.dir))
    expect(t.arg(args, '-p')).toBe('Split T-1.')
    expect(t.arg(args, '--output-format')).toBe('stream-json')
    expect(t.arg(args, '--permission-mode')).toBe('dontAsk')
    expect(t.arg(args, '--allowedTools')).toBe('mcp__tasuki,Read,Bash(git:*)')
    expect(t.arg(args, '--model')).toBe('haiku')
    expect(JSON.parse(t.arg(args, '--mcp-config') ?? '')).toEqual({
      mcpServers: {
        tasuki: {
          type: 'http',
          url: 'http://127.0.0.1:8787/agent-mcp',
          headers: { Authorization: 'Bearer secret-token' },
        },
      },
    })
    // Isolated from this machine's Claude settings unless asked otherwise.
    expect(args).toContain('--strict-mcp-config')
    expect(t.arg(args, '--setting-sources')).toBe('')
    // A new session it names itself, reported to the engine.
    expect(t.sessions).toEqual([t.arg(args, '--session-id')])
    expect(readFileSync(join(t.dir, 'run.log'), 'utf8')).toContain('"type":"result"')
    expect(t.activity()).toBeGreaterThan(0)
  })

  it("gives the agent this config's plugins, MCP servers and standing instructions", async () => {
    const t = setup('', {
      plugins: ['sdd'],
      mcpServers: { docs: { type: 'http', url: 'http://docs' } },
      appendSystemPromptFile: 'base.md',
    })
    await t.runner.start(t.spec()).exit
    const args = t.calls()[0]?.args ?? []
    // Relative to the config folder, so the same config works on any machine.
    expect(t.arg(args, '--plugin-dir')).toBe(join(t.dir, 'sdd'))
    expect(t.arg(args, '--append-system-prompt')).toBe('Commit and push when done.')
    expect(Object.keys(JSON.parse(t.arg(args, '--mcp-config') ?? '').mcpServers)).toEqual([
      'docs',
      'tasuki',
    ])
    // Still isolated: only what the config names is loaded.
    expect(args).toContain('--strict-mcp-config')
  })

  it('loads the machine settings when inheritSettings is on', async () => {
    const t = setup('', { inheritSettings: true })
    await t.runner.start(t.spec()).exit
    const args = t.calls()[0]?.args ?? []
    expect(args).not.toContain('--strict-mcp-config')
    expect(args).not.toContain('--setting-sources')
  })

  it("hands the agent its Run and options.env, never the engine's own secrets", async () => {
    process.env['JIRA_API_TOKEN'] = 'tracker-secret'
    try {
      const t = setup()
      await t.runner.start(t.spec()).exit
      const env = t.calls()[0]?.env ?? {}
      expect(env).toMatchObject({
        TASUKI_RUN_ID: 'run-1',
        TASUKI_TARGET: 'T-1',
        TASUKI_MODE: 'split',
        TASUKI_WORKSPACE: t.dir,
        FAKE_OUT: t.out,
      })
      expect(env['PATH']).toBe(process.env['PATH'])
      expect(env['JIRA_API_TOKEN']).toBeUndefined()
    } finally {
      delete process.env['JIRA_API_TOKEN']
    }
  })

  it('resumes the session it is given', async () => {
    const t = setup()
    await t.runner.start(t.spec({ resume: 'old-session' })).exit
    const args = t.calls()[0]?.args ?? []
    expect(t.arg(args, '--resume')).toBe('old-session')
    expect(args).not.toContain('--session-id')
    expect(t.sessions).toEqual(['old-session'])
  })

  it('starts a new session when the old one cannot be resumed', async () => {
    const t = setup('no-session')
    const exit = await t.runner.start(t.spec({ resume: 'gone' })).exit
    expect(exit.code).toBe(0)
    const [first, second] = t.calls()
    expect(t.arg(first?.args ?? [], '--resume')).toBe('gone')
    const fresh = t.arg(second?.args ?? [], '--session-id')
    expect(fresh).toBeDefined()
    expect(t.sessions).toEqual(['gone', fresh])
  })

  it('ends the whole process tree on terminate', async () => {
    const t = setup('hang')
    const handle = t.runner.start(t.spec())
    let child = 0
    for (let i = 0; i < 100 && child === 0; i++) {
      await sleep(50)
      child = Number(readFileSync(`${t.out}.child`, { encoding: 'utf8', flag: 'a+' }) || 0)
    }
    expect(alive(child)).toBe(true)
    handle.terminate('SIGTERM')
    expect(await handle.exit).toEqual<RunExit>({ code: null, signal: 'SIGTERM' })
    await sleep(100)
    expect(alive(child)).toBe(false)
  })

  it('exits with no code when the CLI is not there, which the engine records as not started', async () => {
    const t = setup()
    const runner = plugin.runner?.(
      {
        clock: { now: () => new Date() },
        configDir: '',
        dataDir: t.dir,
        statuses: createStatusMap({}),
      },
      { command: join(t.dir, 'missing') },
    ) as RunnerPort
    expect(await runner.start(t.spec()).exit).toEqual<RunExit>({ code: null, signal: null })
    expect(readFileSync(join(t.dir, 'run.log'), 'utf8')).toContain('could not start')
  })

  it('refuses options it cannot honour', () => {
    const make = (options: unknown) => () =>
      plugin.runner?.(
        {
          clock: { now: () => new Date() },
          configDir: '',
          dataDir: '',
          statuses: createStatusMap({}),
        },
        options,
      )
    expect(make({ auth: 'api-key' })).toThrow('options.auth "api-key" is not supported yet')
    expect(make({ allowedTools: 'Read' })).toThrow('options.allowedTools must be a list')
    expect(make({ env: { A: 1 } })).toThrow('options.env must map names to strings')
    expect(make({ plugins: ['/nowhere/sdd'] })).toThrow('/nowhere/sdd does not exist')
    expect(make({ mcpServers: { tasuki: {} } })).toThrow('the name tasuki is taken')
    expect(make({ appendSystemPrompt: 'a', appendSystemPromptFile: 'b.md' })).toThrow('not both')
    expect(make({ appendSystemPromptFile: '/nowhere.md' })).toThrow('/nowhere.md does not exist')
  })
})

describe('claude-cli doctor', () => {
  it('a CLI that does not run is the one error', async () => {
    const { runner } = setup('', { command: '/nonexistent/claude', allowedTools: [] })
    const findings = await runner.doctor?.()
    expect(findings).toHaveLength(1)
    expect(findings?.[0]?.level).toBe('error')
    expect(findings?.[0]?.message).toContain('/nonexistent/claude does not run')
  })

  it('warns on empty allowedTools, and starts nothing more when nothing is required', async () => {
    const { runner, calls } = setup('', { allowedTools: [] })
    expect(await runner.doctor?.()).toEqual([
      { level: 'warning', message: expect.stringContaining('allowedTools is empty') },
    ])
    expect(calls().map((c) => c.args)).toEqual([['--version']])
  })

  it('reads the init line for what requires names, then ends the CLI', async () => {
    const { runner, calls } = setup('init', {
      allowedTools: ['Read'],
      mcpServers: { gitlab: { type: 'stdio', command: 'x' } },
      requires: { mcpServers: ['gitlab', 'jira', 'slack'], skills: ['sdd:apply', 'sdd:propose'] },
    })
    expect(await runner.doctor?.()).toEqual([
      { level: 'error', message: 'requires.mcpServers: jira is needs-auth' },
      { level: 'error', message: 'requires.mcpServers: slack is not configured' },
      { level: 'error', message: 'requires.skills: sdd:propose is not loaded' },
    ])
    const probe = calls()[1]?.args ?? []
    expect(probe).toContain('--strict-mcp-config')
    expect(JSON.parse(probe[probe.indexOf('--mcp-config') + 1] ?? '{}')).toEqual({
      mcpServers: { gitlab: { type: 'stdio', command: 'x' } },
    })
  })
})
