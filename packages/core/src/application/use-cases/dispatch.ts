import { exitFor, outcomeOf, type Rule, type RunExit } from '../../domain/rule'
import { nextTaskAttempt, type CancelReason, type Outcome, type Run } from '../../domain/run'
import { DISPATCH_MOVES, isDispatchable } from '../../domain/task'
import { taskStatusName, type StatusNames } from '../../domain/workflow'
import type { Ref, WorkUnit } from '../../domain/work-unit'
import { NotFound } from '../not-found'
import { RunConflict } from '../run-conflict'
import type { StorePort } from '../ports/store'
import type { TrackerPort } from '../ports/tracker'
import { StatusConflict } from '../status-conflict'
import { listTasks } from './list-tasks'

// A dispatch rule (M2, D102): the engine starts one Run per task the graph lets run, and
// decides where the item goes once none is left running (state-machine.md, Dispatch).

export interface DispatchDeps {
  tracker: TrackerPort
  store: StorePort
}

const engineSays = (tracker: TrackerPort, target: Ref, body: string) =>
  tracker.addComment({ target, author: 'engine', kind: 'system', body })

// The tasks of one item a dispatch rule can start now, oldest first, at most `slots` of them.
// Each comes back with a live Run; the caller starts its agent.
export async function claimTasks(
  { tracker, store }: DispatchDeps,
  rule: Rule,
  item: WorkUnit,
  live: ReadonlySet<Ref>,
  slots: number,
  limits: { leaseSeconds: number; workspaceRoot: string },
): Promise<Run[]> {
  const tasks = await listTasks(tracker, item.ref)
  const claimed: Run[] = []
  for (const task of tasks.filter((t) => isDispatchable(t, tasks, live))) {
    if (claimed.length >= slots) break
    const previous = (await store.runsFor(task.ref)).find((r) => r.rule === rule.id)
    const attempt = nextTaskAttempt(previous)
    let run: Run
    try {
      run = await store.createRun({
        target: task.ref,
        item: item.ref,
        rule: rule.id,
        agent: rule.agent,
        attempt,
        from: task.status,
        workspace: `${limits.workspaceRoot}/${item.ref}`,
        leaseSeconds: limits.leaseSeconds,
      })
    } catch (e) {
      if (e instanceof RunConflict) continue
      throw e
    }
    // Recorded as a Run of its own, as an item's max_attempts is (D38): handed back by a
    // person, the task starts over at 1.
    if (attempt > rule.maxAttempts) {
      const moved = await moveTask(tracker, task.ref, task.status, 'manual')
      await store.finishRun(
        run.id,
        moved ? 'max_attempts' : 'cancelled',
        moved ? 'manual' : undefined,
      )
      if (moved)
        await engineSays(
          tracker,
          task.ref,
          `Rule \`${rule.id}\` gave up after ${rule.maxAttempts} attempts. Moved ${taskStatusName(task.status)} → ${taskStatusName('manual')}: a person has to look at it.`,
        )
      continue
    }
    if (task.status === 'to-do' && !(await moveTask(tracker, task.ref, 'to-do', 'in-progress'))) {
      // Someone moved it since the read: theirs wins.
      await store.finishRun(run.id, 'cancelled')
      continue
    }
    claimed.push(run)
  }
  return claimed
}

// Items in a dispatch rule's watch status with no live Run on them or their tasks: all done
// is succeeded, nothing left to start but manual work is blocked_manual. The move has no agent
// behind it, so it is recorded as a Run that started no process (D102), which is what
// auto-resume and the board read. Returns the refs it moved.
export async function settleDispatched(
  { tracker, store, named }: DispatchDeps & { named: StatusNames },
  rules: readonly Rule[],
  limits: { leaseSeconds: number; workspaceRoot: string; holdLabel: string },
): Promise<Ref[]> {
  const dispatching = rules.filter((r) => r.mode === 'dispatch')
  if (dispatching.length === 0) return []
  const busy = new Set((await store.liveRuns()).map((r) => r.item))
  const waiting = await tracker.list(
    'item',
    dispatching.map((r) => r.watch),
  )
  const moved: Ref[] = []
  for (const rule of dispatching) {
    for (const item of waiting.filter((i) => i.status === rule.watch)) {
      if (busy.has(item.ref) || item.labels.includes(limits.holdLabel)) continue
      const tasks = await listTasks(tracker, item.ref)
      const outcome = tasks.every((t) => t.status === 'done')
        ? 'succeeded'
        : !tasks.some((t) => isDispatchable(t, tasks, new Set())) &&
            tasks.some((t) => t.status === 'manual')
          ? 'blocked_manual'
          : undefined
      if (outcome === undefined) continue
      const to = exitFor(rule, outcome)
      if (to === undefined) throw new Error(`rule ${rule.id} has no exit on ${outcome}`)
      let run: Run
      try {
        run = await store.createRun({
          target: item.ref,
          item: item.ref,
          rule: rule.id,
          agent: rule.agent,
          attempt: 1,
          from: rule.watch,
          workspace: `${limits.workspaceRoot}/${item.ref}`,
          leaseSeconds: limits.leaseSeconds,
        })
      } catch (e) {
        if (e instanceof RunConflict) continue
        throw e
      }
      try {
        await tracker.transition(item.ref, rule.watch, to)
      } catch (e) {
        if (!(e instanceof StatusConflict)) throw e
        await store.finishRun(run.id, 'cancelled')
        continue
      }
      await store.finishRun(run.id, outcome, to)
      const done = tasks.filter((t) => t.status === 'done').length
      await engineSays(
        tracker,
        item.ref,
        outcome === 'succeeded'
          ? `Rule \`${rule.id}\`: every task is done. ${named(rule.watch)} → ${named(to)}.`
          : `Rule \`${rule.id}\`: ${done} of ${tasks.length} tasks are done and the rest wait for manual work. ${named(rule.watch)} → ${named(to)}.`,
      )
      moved.push(item.ref)
    }
  }
  return moved
}

const WHY: Record<CancelReason, string> = {
  stop: 'a person pressed Stop',
  hold: 'its item was put on hold',
  moved: 'it or its item was moved while it ran',
  pause: 'the engine was paused with every run stopped',
}

// The worker's process is gone: move its task by the verdict. The item stays where it is;
// settleDispatched decides about it once no task is running.
export async function finishTaskRun(
  { tracker, store }: DispatchDeps,
  rule: Rule,
  run: Run,
  exit: RunExit,
  logTail: string,
): Promise<Outcome> {
  if (run.cancelRequestedAt !== undefined) {
    await store.finishRun(run.id, 'cancelled')
    const lines = [
      `Rule \`${rule.id}\`, attempt ${run.attempt}: \`cancelled\`, ${WHY[run.cancelRequestedBy ?? 'stop']}. The engine moved nothing.`,
    ]
    if (run.summary !== undefined && run.summary !== '') lines.push('', run.summary)
    await engineSays(tracker, run.target, lines.join('\n'))
    return 'cancelled'
  }
  const { outcome, reason } = outcomeOf(rule.mode, run.verdict, exit, {
    tasks: [],
    produced: run.produced,
  })
  const to = DISPATCH_MOVES[outcome] ?? 'to-do'
  if (!(await moveTask(tracker, run.target, 'in-progress', to))) {
    await store.finishRun(run.id, 'cancelled')
    return 'cancelled'
  }
  await store.finishRun(run.id, outcome, to)
  const lines = [
    `Rule \`${rule.id}\`, attempt ${run.attempt}: \`${outcome}\`. ${taskStatusName('in-progress')} → ${taskStatusName(to)}.`,
  ]
  if (reason !== undefined) lines.push(`Why: ${reason}.`)
  if (run.summary !== undefined && run.summary !== '') lines.push('', run.summary)
  if ((exit.code !== 0 || run.verdict === undefined) && logTail.trim() !== '')
    lines.push('', 'The end of the log:', '', '```', logTail.trimEnd(), '```')
  await engineSays(tracker, run.target, lines.join('\n'))
  return outcome
}

// The lease of a task's Run ran out: the task goes back to to-do for the next attempt.
export async function recoverTaskRun(
  { tracker, store }: DispatchDeps,
  rule: Rule | undefined,
  run: Run,
): Promise<void> {
  const task = await tracker.get(run.target).catch((e: unknown) => {
    if (e instanceof NotFound) return undefined
    throw e
  })
  const back =
    task?.status === 'in-progress' && (await moveTask(tracker, run.target, 'in-progress', 'to-do'))
  await store.finishRun(run.id, 'abandoned')
  if (back && rule !== undefined)
    await engineSays(
      tracker,
      run.target,
      `Rule \`${rule.id}\`, attempt ${run.attempt}: the agent stopped answering. Moved ${taskStatusName('in-progress')} → ${taskStatusName('to-do')} to try again.`,
    )
}

// false when a person moved it meanwhile: theirs wins.
async function moveTask(
  tracker: TrackerPort,
  ref: Ref,
  from: string,
  to: string,
): Promise<boolean> {
  try {
    await tracker.transition(ref, from, to)
    return true
  } catch (e) {
    if (e instanceof StatusConflict) return false
    throw e
  }
}
