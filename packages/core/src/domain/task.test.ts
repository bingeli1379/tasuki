import { describe, expect, it } from 'vite-plus/test'
import { agentMoveRefusal, isRunnable, personMoveRefusal, type TaskNode } from './task'

const task = (ref: string, status: string, blockedBy: string[] = []): TaskNode => ({
  ref,
  status,
  blockedBy,
})

describe('isRunnable', () => {
  it('is a to-do task whose blockers are all done', () => {
    const all = [task('A', 'done'), task('B', 'in-review'), task('C', 'to-do', ['A'])]
    expect(isRunnable(all[2] as TaskNode, all)).toBe(true)
    expect(isRunnable(task('D', 'to-do', ['A', 'B']), all)).toBe(false)
    expect(isRunnable(task('E', 'manual'), all)).toBe(false)
  })
})

// state-machine.md, the task diagram, as the agent walks it.
describe('agentMoveRefusal', () => {
  it.each([
    ['to-do', 'in-progress'],
    ['in-progress', 'in-review'],
    ['in-review', 'done'],
    ['in-review', 'in-progress'],
    ['in-progress', 'to-do'],
    ['to-do', 'manual'],
    ['in-progress', 'manual'],
  ])('lets the agent move %s to %s', (from, to) => {
    expect(agentMoveRefusal(task('A', from), to, [])).toBeUndefined()
  })

  it.each([
    ['to-do', 'done', 'A cannot go from to-do to done'],
    ['in-progress', 'done', 'A cannot go from in-progress to done'],
    ['to-do', 'in-review', 'A cannot go from to-do to in-review'],
    ['in-review', 'to-do', 'A cannot go from in-review to to-do'],
    ['to-do', 'refining', 'A cannot go from to-do to refining'],
    ['manual', 'done', 'A is manual; only a person moves it out'],
    ['manual', 'to-do', 'A is manual; only a person moves it out'],
    // invariant 4
    ['done', 'in-progress', 'A is done; done tasks are never reopened'],
  ])('refuses %s to %s', (from, to, why) => {
    expect(agentMoveRefusal(task('A', from), to, [])).toBe(why)
  })

  it('refuses to start a task before what it waits for is done', () => {
    const all = [task('A', 'in-review'), task('B', 'to-do', ['A'])]
    expect(agentMoveRefusal(all[1] as TaskNode, 'in-progress', all)).toBe(
      'B waits for tasks that are not done',
    )
  })
})

// state-machine.md, the task diagram, as a person walks it.
describe('personMoveRefusal', () => {
  it.each([
    ['to-do', 'manual'],
    ['in-progress', 'manual'],
    ['manual', 'done'],
    ['manual', 'to-do'],
  ])('lets a person move %s to %s', (from, to) => {
    expect(personMoveRefusal('A', from, to)).toBeUndefined()
  })

  it.each([
    ['to-do', 'done', 'A cannot go from to-do to done'],
    ['to-do', 'in-progress', 'A cannot go from to-do to in-progress'],
    ['in-review', 'manual', 'A cannot go from in-review to manual'],
    ['manual', 'in-progress', 'A cannot go from manual to in-progress'],
    // invariant 4
    ['done', 'manual', 'A is done; done tasks are never reopened'],
  ])('refuses %s to %s', (from, to, why) => {
    expect(personMoveRefusal('A', from, to)).toBe(why)
  })
})
