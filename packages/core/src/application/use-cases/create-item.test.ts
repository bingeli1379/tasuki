import { describe, expect, it } from 'vite-plus/test'
import { trackerStub } from '../../testing/tracker-stub'
import type { NewItem, TrackerPort } from '../ports/tracker'
import { createItem } from './create-item'

const recording = (): { tracker: TrackerPort; created: NewItem[] } => {
  const created: NewItem[] = []
  const tracker = trackerStub({
    createItem: (item) => {
      created.push(item)
      return Promise.resolve({ ref: 'X-1', kind: 'item', labels: [], version: '1', ...item })
    },
  })
  return { tracker, created }
}

describe('createItem', () => {
  it('creates the item at the entry station with a trimmed title', async () => {
    const { tracker, created } = recording()
    await createItem(tracker, 'triage', { title: '  Login page  ', body: 'details' })
    expect(created).toEqual([{ title: 'Login page', body: 'details', status: 'triage' }])
  })

  it('rejects a blank title without touching the tracker', async () => {
    const { tracker, created } = recording()
    await expect(createItem(tracker, 'triage', { title: '   ', body: '' })).rejects.toThrow(
      'title is required',
    )
    expect(created).toEqual([])
  })
})
