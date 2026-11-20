import { exitFor, outcomeOf, runningStatus, type Rule, type RunExit } from '../../domain/rule'
import type { Outcome } from '../../domain/run'
import type { RuntimeStorePort } from '../ports/runtime-store'
import type { StoragePort } from '../ports/storage'
import { StatusConflict } from '../status-conflict'
import { listTasks } from './list-tasks'
import { releaseTasks } from './release-tasks'

export interface FinishDeps {
  storage: StoragePort
  runtime: RuntimeStorePort
}

// The agent process is gone: turn what it reported into an outcome and move the item.
export async function finishRun(
  { storage, runtime }: FinishDeps,
  rule: Rule,
  runId: string,
  exit: RunExit,
): Promise<Outcome> {
  const run = await runtime.getRun(runId)
  // Recovery already gave up on it, and the item may be on its next attempt by now.
  if (run.outcome !== undefined) return run.outcome
  const tasks = await listTasks(storage, run.target)
  let { outcome, reason } = outcomeOf(rule.mode, run.verdict, exit, {
    tasks,
    produced: run.produced,
  })
  // e.g. blocked_manual from a split agent: leaving the item in the claim status with no
  // Run would strand it there.
  if (exitFor(rule, outcome) === undefined) {
    reason = `rule ${rule.id} has nowhere to go on ${outcome}`
    outcome = 'failed'
  }
  const to = exitFor(rule, outcome) ?? 'blocked'
  // Moved before the Run is finished: a crash in between leaves a live Run whose lease
  // expires, never an item stuck in the claim status with nothing to bring it back.
  try {
    await storage.transition(run.target, runningStatus(rule), to)
  } catch (e) {
    // A person moved it while the agent worked; theirs wins and nothing more is written.
    if (!(e instanceof StatusConflict)) throw e
    await runtime.finishRun(run.id, 'cancelled')
    return 'cancelled'
  }
  await runtime.finishRun(run.id, outcome)
  const lines = [`Rule ${rule.id}, attempt ${run.attempt}: ${outcome}, moved to ${to}.`]
  if (reason !== undefined) lines.push(`Why: ${reason}.`)
  if (run.summary !== undefined && run.summary !== '') lines.push('', run.summary)
  await storage.addComment({
    target: run.target,
    author: 'engine',
    kind: 'system',
    body: lines.join('\n'),
  })
  await releaseTasks(storage, tasks, `rule ${rule.id}'s run ended ${outcome}`)
  return outcome
}
