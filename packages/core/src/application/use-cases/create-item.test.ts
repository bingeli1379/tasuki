import { describe, expect, it } from 'vite-plus/test'
import type { NewItem, StoragePort } from '../ports/storage'
import { createItem } from './create-item'

const recording = (): { storage: StoragePort; created: NewItem[] } => {
  const created: NewItem[] = []
  const storage: StoragePort = {
    list: () => Promise.resolve([]),
    createItem: (item) => {
      created.push(item)
      return Promise.resolve({ ref: 'X-1', kind: 'item', labels: [], ...item })
    },
  }
  return { storage, created }
}

describe('createItem', () => {
  it('creates the item in refining with a trimmed title', async () => {
    const { storage, created } = recording()
    await createItem(storage, { title: '  Login page  ', body: 'details' })
    expect(created).toEqual([{ title: 'Login page', body: 'details', status: 'refining' }])
  })

  it('rejects a blank title without touching the tracker', async () => {
    const { storage, created } = recording()
    await expect(createItem(storage, { title: '   ', body: '' })).rejects.toThrow(
      'title is required',
    )
    expect(created).toEqual([])
  })
})
