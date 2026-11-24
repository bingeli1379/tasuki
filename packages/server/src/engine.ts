import {
  beat,
  claimItems,
  detectOverrides,
  expandPrompt,
  finishRun,
  itemStatusNames,
  recoverRuns,
  resumeBlocked,
  resumeReleased,
  settleDispatched,
  type Claimed,
  type Clock,
  type RunExit,
  type RunHandle,
  type RunnerPort,
  type StorePort,
  type TrackerPort,
} from '@tasuki/core'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Limits } from './instance'
import type { LiveFlow } from './flow'
import { CONTRACT } from './prompts'
import type { Approvals } from './approvals'
import type { RunTokens } from './run-tokens'

const TAIL_LINES = 20
const TAIL_CHARS = 2000

export interface EngineDeps {
  tracker: TrackerPort
  store: StorePort
  clock: Clock
  // Read once a round: a save of the flow takes effect on the next one (D91).
  flow: LiveFlow
  // Read again at each use: an admin's save on the General page applies at once (D105).
  limits: () => Limits
  workspaceRoot: string
  // Each Run's log is <logDir>/<run id>.log, on this machine whichever store holds the Run.
  logDir: string
  // One per agent name, read at each Run's start: a save on the Agents page applies from the
  // next Run (D107).
  runners: () => Readonly<Record<string, RunnerPort>>
  tokens: RunTokens
  // What its agents wait on a person for; denied once their Run is over (D107).
  approvals: Approvals
  // Where agents reach the MCP facade.
  mcpUrl: string
  // What its heartbeat on the tracker says it is (D66).
  engineId: string
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
  const { tracker, store, clock, limits, tokens, log = console.error } = deps
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

  async function start(
    { run, rule }: Claimed,
    named: ReturnType<typeof itemStatusNames>,
  ): Promise<{ done: Promise<void> }> {
    const runner = deps.runners()[rule.agent]
    const token = tokens.issue(run.id, rule)
    const renew = setInterval(
      () => {
        store.renewLease(run.id, limits().leaseSeconds).catch((e: unknown) => log(String(e)))
      },
      (limits().leaseSeconds * 1000) / 3,
    )
    const logPath = join(deps.logDir, `${run.id}.log`)
    let exit: Promise<RunExit>
    try {
      if (runner === undefined) throw new Error(`no runner for agent ${rule.agent}`)
      await mkdir(run.workspace, { recursive: true })
      await mkdir(deps.logDir, { recursive: true })
      const resume =
        rule.session === 'per-item'
          ? (await store.runsFor(run.target)).find(
              (r) => r.agent === rule.agent && r.sessionId !== undefined,
            )?.sessionId
          : undefined
      // At most one write a second, however much the agent prints.
      let touched = 0
      const handle = runner.start({
        runId: run.id,
        target: run.target,
        workspace: run.workspace,
        mcp: { url: deps.mcpUrl, token },
        prompt: expandPrompt(`${CONTRACT}\n\n${rule.prompt}`, {
          ref: run.item,
          ...(run.target === run.item ? {} : { task: run.target }),
          runId: run.id,
          workspace: run.workspace,
        }),
        ...(resume === undefined ? {} : { resume }),
        logPath,
        onActivity() {
          const now = clock.now().getTime()
          if (now - touched < 1000) return
          touched = now
          store.touch(run.id).catch((e: unknown) => log(String(e)))
        },
        onSession(id) {
          store.recordSession(run.id, id).catch((e: unknown) => log(String(e)))
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
        deps.approvals.drop(run.id)
        if (result.denials !== undefined)
          await store.recordDenials(run.id, result.denials).catch((e: unknown) => log(String(e)))
        await finishRun({ tracker, store, named }, rule, run.id, result, await logTail(logPath))
      }),
    }
  }

  return {
    async tick() {
      if (ticking) return
      ticking = true
      try {
        // Stopped or paused, it still holds the project: a second engine must not start.
        await beat(tracker, clock, deps.engineId)
        // A station keyed to a status the tracker lacks would fail at the first move, so
        // nothing runs until the settings page maps it (D91).
        if (deps.flow.unmatched.length > 0) return
        const { workflow, rules, holdLabel } = deps.flow.current()
        const named = itemStatusNames(workflow)
        await recoverRuns({ tracker, store, clock, named }, rules)
        await detectOverrides({ tracker, store }, rules, holdLabel)
        // Before claiming, so an item resumed this round is picked up in the same round.
        await resumeBlocked({ tracker, store, named }, rules, holdLabel)
        await resumeReleased({ tracker, store, named }, rules, holdLabel)
        // No agent behind it, so a paused engine still moves an item whose tasks are through.
        await settleDispatched({ tracker, store, named }, rules, {
          leaseSeconds: limits().leaseSeconds,
          workspaceRoot: deps.workspaceRoot,
          holdLabel,
        })
        // Paused, the round still recovers and resumes: none of that starts a Run.
        if (await store.isPaused()) return
        const claimed = await claimItems({ tracker, store, named }, rules, {
          maxConcurrentRuns: limits().maxConcurrentRuns,
          leaseSeconds: limits().leaseSeconds,
          workspaceRoot: deps.workspaceRoot,
          holdLabel,
        })
        for (const c of claimed) {
          const p = (await start(c, named)).done
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
        for (const run of await store.liveRuns()) {
          const agent = agents.get(run.id)
          if (agent === undefined || run.cancelRequestedAt === undefined) continue
          const now = clock.now().getTime()
          if (run.cancelMode === 'soft') {
            if (now - Date.parse(run.cancelRequestedAt) < limits().softGraceSeconds * 1000) continue
            await store.requestCancel(run.id, 'hard', run.cancelRequestedBy ?? 'stop')
          }
          if (agent.termAt === undefined) {
            agent.termAt = now
            agent.handle.terminate('SIGTERM')
          } else if (
            agent.killed !== true &&
            now - agent.termAt >= limits().hardGraceSeconds * 1000
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
