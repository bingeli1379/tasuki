import {
  claimItems,
  finishRun,
  recoverRuns,
  resumeBlocked,
  type Claimed,
  type Clock,
  type Rule,
  type RunExit,
  type RunnerPort,
  type RuntimeStorePort,
  type StoragePort,
} from '@tasuki/core'
import { mkdir } from 'node:fs/promises'
import type { Limits } from './config'
import type { RunTokens } from './run-tokens'

// The label that tells the engine to keep off an item. config labels.hold names it in S7c.
const HOLD_LABEL = 'hold'

export interface EngineDeps {
  storage: StoragePort
  runtime: RuntimeStorePort
  clock: Clock
  rules: readonly Rule[]
  limits: Limits
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
  // Resolves once every agent started so far has exited and its Run is finished.
  settled(): Promise<void>
}

export function createEngine(deps: EngineDeps): Engine {
  const { storage, runtime, clock, rules, limits, tokens, log = console.error } = deps
  const inFlight = new Set<Promise<void>>()
  let ticking = false

  // Returns once the agent is running. `done` is the rest of its life, settling when its Run
  // is finished; it sits in an object because an async function would flatten it.
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
      exit = runner.start({
        runId: run.id,
        target: run.target,
        mode: rule.mode,
        workspace: run.workspace,
        mcp: { url: deps.mcpUrl, token },
      }).exit
    } catch (e) {
      log(`run ${run.id} on ${run.target}: ${e instanceof Error ? e.message : String(e)}`)
      exit = Promise.resolve({ code: null, signal: null })
    }
    return {
      done: exit.then(async (result) => {
        clearInterval(renew)
        tokens.revoke(run.id)
        await finishRun({ storage, runtime }, rule, run.id, result)
      }),
    }
  }

  return {
    async tick() {
      if (ticking) return
      ticking = true
      try {
        await recoverRuns({ storage, runtime, clock }, rules)
        // Before claiming, so an item resumed this round is picked up in the same round.
        await resumeBlocked({ storage, runtime }, rules, HOLD_LABEL)
        const claimed = await claimItems({ storage, runtime }, rules, {
          maxConcurrentRuns: limits.maxConcurrentRuns,
          leaseSeconds: limits.leaseSeconds,
          workspaceRoot: deps.workspaceRoot,
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
    async settled() {
      while (inFlight.size > 0) await Promise.all(inFlight)
    },
  }
}
