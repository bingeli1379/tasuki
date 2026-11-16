import type { StoragePort } from '@tasuki/core'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

export interface StorageFixture {
  storage: StoragePort
  teardown?: () => Promise<void>
}

// Every tracker plugin runs this suite. The fixture must map the item status `refining`.
// Trackers may already hold other items, so assertions look for what this suite created.
export function describeStorageContract(name: string, setup: () => Promise<StorageFixture>): void {
  describe(`StoragePort contract: ${name}`, () => {
    let fixture: StorageFixture

    beforeAll(async () => {
      fixture = await setup()
    })
    afterAll(async () => {
      await fixture.teardown?.()
    })

    it('createItem returns the item with a ref and the requested status', async () => {
      const item = await fixture.storage.createItem({
        title: 'contract: create',
        body: 'first line\nsecond line',
        status: 'refining',
      })
      expect(item.ref).not.toBe('')
      expect(item).toMatchObject({
        kind: 'item',
        title: 'contract: create',
        body: 'first line\nsecond line',
        status: 'refining',
        labels: [],
      })
    })

    it('a created item is listed under its status', async () => {
      const item = await fixture.storage.createItem({
        title: 'contract: list',
        body: '',
        status: 'refining',
      })
      const listed = await fixture.storage.list('item', 'refining')
      expect(listed.find((u) => u.ref === item.ref)).toEqual(item)
    })
  })
}
