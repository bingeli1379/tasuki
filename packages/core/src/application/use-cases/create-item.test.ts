import { describe, expect, it } from 'vite-plus/test'
import { storageStub } from '../../testing/storage-stub'
import type { NewItem, StoragePort } from '../ports/storage'
import { createItem } from './create-item'

const recording = (): { storage: StoragePort; created: NewItem[] } => {
  const created: NewItem[] = []
  const storage = storageStub({
    createItem: (item) => {
      created.push(item)
      return Promise.resolve({ ref: 'X-1', kind: 'item', labels: [], version: '1', ...item })
    },
  })
  return { storage, created }
}

describe('createItem', () => {
  it('creates the item at the entry station with a trimmed title', async () => {
    const { storage, created } = recording()
    await createItem(storage, 'triage', { title: '  Login page  ', body: 'details' })
    expect(created).toEqual([{ title: 'Login page', body: 'details', status: 'triage' }])
  })

  it('rejects a blank title without touching the tracker', async () => {
    const { storage, created } = recording()
    await expect(createItem(storage, 'triage', { title: '   ', body: '' })).rejects.toThrow(
      'title is required',
    )
    expect(created).toEqual([])
  })
})
