import {
  claimItems,
  detectOverrides,
  expandPrompt,
  finishRun,
  recoverRuns,
  resumeBlocked,
  resumeReleased,
  type Claimed,
  type Clock,
  type Rule,
  type RunExit,
  type RunHandle,
  type RunnerPort,
  type RuntimeStorePort,
  type StatusNames,
  type StoragePort,
} from '@tasuki/core'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Limits } from './config'
import { CONTRACT } from './prompts'
import type { RunTokens } from './run-tokens'

const TAIL_LINES = 20
const TAIL_CHARS = 2000

export interface EngineDeps {
  storage: StoragePort
  runtime: RuntimeStorePort
  clock: Clock
  rules: readonly Rule[]
  // How a status reads in the comments the engine writes.
  named: StatusNames
  limits: Limits
  holdLabel: string
  workspaceRoot: string
  // One per agent name in config.
  runners: Readonly<Record<string, RunnerPort>>
  tokens: RunTokens
  // Where agents reach the MCP facade.
  mcpUrl: string
  log?: (message: string) => void
}

export interface Engine {
  // One Poller round. Rounds never overlap: a call while one is going returns at once.
  tick(): Promise<void>
  // Ends the agents of Runs a person asked to stop, from the local store alone, so it can
  // run every second: SIGTERM for a hard cancel, a soft one turned hard once
  // softGraceSeconds pass, SIGKILL hardGraceSeconds after SIGTERM. Never overlaps either.
  enforce(): Promise<void>
  // Resolves once every agent started so far has exited and its Run is finished.
  settled(): Promise<void>
}

export function createEngine(deps: EngineDeps): Engine {
  const { storage, runtime, clock, rules, limits, tokens, log = console.error } = deps
  const inFlight = new Set<Promise<void>>()
  // The agents this engine started that have not exited yet, by Run id.
  const agents = new Map<string, { handle: RunHandle; termAt?: number; killed?: boolean }>()
  let ticking = false
  let enforcing = false

  // Returns once the agent is running. `done` is the rest of its life, settling when its Run
  // is finished; it sits in an object because an async function would flatten it.
  // The last lines the agent printed, for the comment on a Run that died. Empty when it
  // wrote no log.
  async function logTail(path: string): Promise<string> {
    const text = await readFile(path, 'utf8').catch(() => '')
    return text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS)
  }

  async function start({ run, rule }: Claimed): Promise<{ done: Promise<void> }> {
    const runner = deps.runners[rule.agent]
    const token = tokens.issue(run.id)
    const renew = setInterval(
      () => {
        runtime.renewLease(run.id, limits.leaseSeconds).catch((e: unknown) => log(String(e)))
      },
      (limits.leaseSeconds * 1000) / 3,
    )
    let exit: Promise<RunExit>
    try {
      if (runner === undefined) throw new Error(`no runner for agent ${rule.agent}`)
      await mkdir(run.workspace, { recursive: true })
      await mkdir(dirname(run.logPath), { recursive: true })
      const resume =
        rule.session === 'per-item'
          ? (await runtime.runsFor(run.target)).find(
              (r) => r.agent === rule.agent && r.sessionId !== undefined,
            )?.sessionId
          : undefined
      // At most one write a second, however much the agent prints.
      let touched = 0
      const handle = runner.start({
        runId: run.id,
        target: run.target,
        mode: rule.mode,
        workspace: run.workspace,
        mcp: { url: deps.mcpUrl, token },
        prompt: expandPrompt(`${CONTRACT}\n\n${rule.prompt}`, {
          ref: run.target,
          runId: run.id,
          workspace: run.workspace,
          mode: rule.mode,
        }),
        ...(resume === undefined ? {} : { resume }),
        logPath: run.logPath,
        onActivity() {
          const now = clock.now().getTime()
          if (now - touched < 1000) return
          touched = now
          runtime.touch(run.id).catch((e: unknown) => log(String(e)))
        },
        onSession(id) {
          runtime.recordSession(run.id, id).catch((e: unknown) => log(String(e)))
        },
      })
      agents.set(run.id, { handle })
      exit = handle.exit
    } catch (e) {
      log(`run ${run.id} on ${run.target}: ${e instanceof Error ? e.message : String(e)}`)
      exit = Promise.resolve({ code: null, signal: null })
    }
    return {
      done: exit.then(async (result) => {
        agents.delete(run.id)
        clearInterval(renew)
        tokens.revoke(run.id)
        await finishRun(
          { storage, runtime, named: deps.named },
          rule,
          run.id,
          result,
          await logTail(run.logPath),
        )
      }),
    }
  }

  return {
    async tick() {
      if (ticking) return
      ticking = true
      try {
        await recoverRuns({ storage, runtime, clock, named: deps.named }, rules)
        await detectOverrides({ storage, runtime }, rules, deps.holdLabel)
        // Before claiming, so an item resumed this round is picked up in the same round.
        await resumeBlocked({ storage, runtime, named: deps.named }, rules, deps.holdLabel)
        await resumeReleased({ storage, runtime, named: deps.named }, rules, deps.holdLabel)
        // Paused, the round still recovers and resumes: none of that starts a Run.
        if (await runtime.isPaused()) return
        const claimed = await claimItems({ storage, runtime, named: deps.named }, rules, {
          maxConcurrentRuns: limits.maxConcurrentRuns,
          leaseSeconds: limits.leaseSeconds,
          workspaceRoot: deps.workspaceRoot,
          holdLabel: deps.holdLabel,
        })
        for (const c of claimed) {
          const p = (await start(c)).done
            .catch((e: unknown) => log(`run ${c.run.id}: ${String(e)}`))
            .finally(() => inFlight.delete(p))
          inFlight.add(p)
        }
      } catch (e) {
        log(`poll: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        ticking = false
      }
    },
    async enforce() {
      if (enforcing) return
      enforcing = true
      try {
        for (const run of await runtime.liveRuns()) {
          const agent = agents.get(run.id)
          if (agent === undefined || run.cancelRequestedAt === undefined) continue
          const now = clock.now().getTime()
          if (run.cancelMode === 'soft') {
            if (now - Date.parse(run.cancelRequestedAt) < limits.softGraceSeconds * 1000) continue
            await runtime.requestCancel(run.id, 'hard', run.cancelRequestedBy ?? 'stop')
          }
          if (agent.termAt === undefined) {
            agent.termAt = now
            agent.handle.terminate('SIGTERM')
          } else if (
            agent.killed !== true &&
            now - agent.termAt >= limits.hardGraceSeconds * 1000
          ) {
            agent.killed = true
            agent.handle.terminate('SIGKILL')
          }
        }
      } catch (e) {
        log(`enforce: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        enforcing = false
      }
    },
    async settled() {
      while (inFlight.size > 0) await Promise.all(inFlight)
    },
  }
}
