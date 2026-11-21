import { describe, expect, it } from 'vite-plus/test'
import type { Workflow } from '../../domain/workflow'
import { storageStub } from '../../testing/storage-stub'
import type { StoragePort } from '../ports/storage'
import { StatusConflict } from '../status-conflict'
import { moveItem } from './move-item'
import { requestRework } from './request-rework'

const recording = (): { storage: StoragePort; moves: string[][] } => {
  const moves: string[][] = []
  const storage = storageStub({
    addComment: (c) => (
      moves.push([c.target, c.kind, c.body]),
      Promise.resolve({ ...c, id: '1', createdAt: '' })
    ),
    transition: (ref, from, to) => {
      moves.push([ref, from, to])
      return Promise.resolve({
        ref,
        kind: 'item',
        title: 't',
        body: '',
        status: to,
        labels: [],
        version: '2',
      })
    },
  })
  return { storage, moves }
}

const workflowOf = (ids: string[], rework?: string): Workflow => ({
  statuses: ids.map((id) => ({ id, name: id.toUpperCase(), outcomes: {} })),
  roles: { entry: 'refining', done: 'done', failure: 'done', ...(rework ? { rework } : {}) },
})
const board = workflowOf(['refining', 'ready-to-split', 'done'])

describe('moveItem', () => {
  it('transitions from the status the person saw to the one they picked', async () => {
    const { storage, moves } = recording()
    const item = await moveItem(storage, board, { ref: 'X-1', from: 'refining', to: 'done' })
    // A person's move leaves a line saying so (D74).
    expect(moves).toEqual([
      ['X-1', 'refining', 'done'],
      ['X-1', 'system', 'Moved **REFINING** → **DONE**.'],
    ])
    expect(item.status).toBe('done')
  })

  it('rejects a status the board does not show without touching the tracker', async () => {
    const { storage, moves } = recording()
    await expect(
      moveItem(storage, board, { ref: 'X-1', from: 'refining', to: 'blocked' }),
    ).rejects.toThrow('status "blocked" is not on the board')
    expect(moves).toEqual([])
  })

  it('rejects a from status the board does not show, e.g. a typo from an AI client', async () => {
    const { storage, moves } = recording()
    await expect(
      moveItem(storage, board, { ref: 'X-1', from: 'refinig', to: 'done' }),
    ).rejects.toThrow('status "refinig" is not on the board')
    expect(moves).toEqual([])
  })

  it('rejects a move to the status it is already in', async () => {
    const { storage, moves } = recording()
    await expect(
      moveItem(storage, board, { ref: 'X-1', from: 'done', to: 'done' }),
    ).rejects.toThrow('X-1 is already in done')
    expect(moves).toEqual([])
  })
})

describe('requestRework', () => {
  const setup = (status = 'in-review') => {
    const log: string[] = []
    const item = {
      ref: 'X-1',
      kind: 'item' as const,
      title: 't',
      body: '',
      status,
      labels: [],
      version: '1',
    }
    const storage = storageStub({
      get: () => Promise.resolve(item),
      addComment: (c) => (
        log.push(`comment ${c.author} ${c.body}`),
        Promise.resolve({ ...c, id: '1', createdAt: '' })
      ),
      transition: (ref, from, to) => (
        log.push(`move ${from}>${to}`),
        Promise.resolve({ ...item, status: to })
      ),
    })
    return { storage, log }
  }
  const mapped = workflowOf(['in-review', 'ready-to-rework', 'done'], 'ready-to-rework')

  it('leaves the feedback first, then sends the item back', async () => {
    const { storage, log } = setup()
    const moved = await requestRework(storage, mapped, {
      ref: 'X-1',
      from: 'in-review',
      feedback: 'Wrong colour.',
    })
    expect(moved.status).toBe('ready-to-rework')
    expect(log).toEqual([
      'comment human Wrong colour.',
      'move in-review>ready-to-rework',
      'comment human Moved **IN-REVIEW** → **READY-TO-REWORK**.',
    ])
  })

  it('refuses without feedback, and leaves no comment when the item already moved', async () => {
    const { storage, log } = setup('done')
    await expect(
      requestRework(storage, mapped, {
        ref: 'X-1',
        from: 'in-review',
        feedback: ' ',
      }),
    ).rejects.toThrow('feedback is empty')
    await expect(
      requestRework(storage, mapped, {
        ref: 'X-1',
        from: 'in-review',
        feedback: 'Wrong.',
      }),
    ).rejects.toBeInstanceOf(StatusConflict)
    expect(log).toEqual([])
  })

  it('refuses when no status has the rework role', async () => {
    const { storage, log } = setup()
    await expect(
      requestRework(storage, workflowOf(['in-review', 'done']), {
        ref: 'X-1',
        from: 'in-review',
        feedback: 'x',
      }),
    ).rejects.toThrow('no status has the rework role')
    expect(log).toEqual([])
  })
})
