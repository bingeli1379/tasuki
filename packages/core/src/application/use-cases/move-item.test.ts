import { describe, expect, it } from 'vite-plus/test'
import { storageStub } from '../../testing/storage-stub'
import type { StoragePort } from '../ports/storage'
import { moveItem } from './move-item'

const recording = (): { storage: StoragePort; moves: string[][] } => {
  const moves: string[][] = []
  const storage = storageStub({
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

const board = ['refining', 'ready-to-split', 'done']

describe('moveItem', () => {
  it('transitions from the status the person saw to the one they picked', async () => {
    const { storage, moves } = recording()
    const item = await moveItem(storage, board, { ref: 'X-1', from: 'refining', to: 'done' })
    expect(moves).toEqual([['X-1', 'refining', 'done']])
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
