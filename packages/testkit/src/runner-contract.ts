import type { RunExit, RunnerPort, RunSpec } from '@tasuki/core'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// What the stand-in for the agent CLI does once started:
// succeed: prints what a finished agent prints and exits 0.
// hang: starts a child process of its own and waits until it is ended.
// no-session: refuses to resume any session, the way the CLI does for one it never kept, and
// succeeds when started fresh.
export type RunnerBehavior = 'succeed' | 'hang' | 'no-session'

export interface RunnerFixture {
  // A runner whose CLI is a stand-in doing what behavior says.
  runner(behavior: RunnerBehavior): RunnerPort
  // A runner whose CLI is not installed.
  missing(): RunnerPort
}

interface Started {
  exit: Promise<RunExit>
  terminate: (signal: 'SIGTERM' | 'SIGKILL') => void
  sessions: string[]
  activity: () => number
  logPath: string
}

function start(runner: RunnerPort, resume?: string): Started {
  const dir = mkdtempSync(join(tmpdir(), 'tasuki-runner-'))
  const sessions: string[] = []
  let activity = 0
  const spec: RunSpec = {
    runId: 'run-1',
    target: 'T-1',
    workspace: dir,
    mcp: { url: 'http://127.0.0.1:1/agent-mcp', token: 'run-token' },
    prompt: 'Split T-1.',
    ...(resume === undefined ? {} : { resume }),
    logPath: join(dir, 'run.log'),
    onActivity: () => {
      activity++
    },
    onSession: (id) => {
      sessions.push(id)
    },
  }
  const handle = runner.start(spec)
  return {
    exit: handle.exit,
    terminate: (signal) => handle.terminate(signal),
    sessions,
    activity: () => activity,
    logPath: spec.logPath,
  }
}

// Every runner plugin runs this suite against a stand-in for its CLI. What a runner passes the
// CLI (flags, the prompt, the MCP facade) is its own and is tested next to it.
export function describeRunnerContract(name: string, setup: () => Promise<RunnerFixture>): void {
  describe(`RunnerPort contract: ${name}`, () => {
    it('ends with the code the CLI exits with, logs what it printed, and reports activity and the session', async () => {
      const run = start((await setup()).runner('succeed'))
      expect(await run.exit).toEqual({ code: 0, signal: null })
      expect(readFileSync(run.logPath, 'utf8')).not.toBe('')
      expect(run.activity()).toBeGreaterThan(0)
      expect(run.sessions.at(-1)).toMatch(/\S/)
    })

    it('starts a new session when the one to resume is gone, and reports that one', async () => {
      const run = start((await setup()).runner('no-session'), 'gone-session')
      expect((await run.exit).code).toBe(0)
      const last = run.sessions.at(-1)
      expect(last).toMatch(/\S/)
      expect(last).not.toBe('gone-session')
    })

    it('ends once terminated', async () => {
      const run = start((await setup()).runner('hang'))
      await new Promise((r) => setTimeout(r, 300))
      run.terminate('SIGTERM')
      const exit = await Promise.race([
        run.exit,
        new Promise<'still running'>((r) => setTimeout(() => r('still running'), 5000)),
      ])
      expect(exit).not.toBe('still running')
      expect(exit).not.toEqual({ code: 0, signal: null })
    })

    it('ends with no code when the CLI is not there, which the engine records as not started', async () => {
      const run = start((await setup()).missing())
      expect(await run.exit).toEqual({ code: null, signal: null })
    })
  })
}
