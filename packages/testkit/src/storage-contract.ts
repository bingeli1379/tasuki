import { NotFound, StatusConflict, type StoragePort } from '@tasuki/core'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

export interface StorageFixture {
  storage: StoragePort
  teardown?: () => Promise<void>
}

// Every tracker plugin runs this suite. The fixture must map the item statuses `refining`,
// `ready-to-split` and `in-progress`.
// Trackers may already hold other items, so assertions look for what this suite created.
export function describeStorageContract(name: string, setup: () => Promise<StorageFixture>): void {
  // A remote tracker takes several round trips per test (create, re-read, transition).
  describe(`StoragePort contract: ${name}`, { timeout: 30_000 }, () => {
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

    // list may lag behind writes (StoragePort), so wait for the item to appear.
    it('a created item is listed under its status', { timeout: 15_000 }, async () => {
      const item = await fixture.storage.createItem({
        title: 'contract: list',
        body: '',
        status: 'refining',
      })
      await expect
        .poll(
          async () =>
            (await fixture.storage.list('item', 'refining')).find((u) => u.ref === item.ref),
          { timeout: 10_000, interval: 500 },
        )
        .toEqual(item)
    })

    it('get returns the unit as it is now', async () => {
      const item = await fixture.storage.createItem({
        title: 'contract: get',
        body: '',
        status: 'refining',
      })
      expect(await fixture.storage.get(item.ref)).toEqual(item)
    })

    it('transition moves the unit and returns it in the new status', async () => {
      const item = await fixture.storage.createItem({
        title: 'contract: transition',
        body: '',
        status: 'refining',
      })
      const moved = await fixture.storage.transition(item.ref, 'refining', 'ready-to-split')
      expect(moved).toEqual({ ...item, status: 'ready-to-split' })
      expect(await fixture.storage.get(item.ref)).toEqual(moved)
    })

    it('transition from a status the unit has already left is a StatusConflict', async () => {
      const item = await fixture.storage.createItem({
        title: 'contract: conflict',
        body: '',
        status: 'refining',
      })
      await fixture.storage.transition(item.ref, 'refining', 'ready-to-split')

      const stale = fixture.storage.transition(item.ref, 'refining', 'in-progress')
      await expect(stale).rejects.toBeInstanceOf(StatusConflict)
      await expect(stale).rejects.toMatchObject({ current: { status: 'ready-to-split' } })
      expect((await fixture.storage.get(item.ref)).status).toBe('ready-to-split')
    })

    it('an unknown ref is NotFound for get and transition', async () => {
      const ref = 'NOPE-999999'
      await expect(fixture.storage.get(ref)).rejects.toBeInstanceOf(NotFound)
      await expect(
        fixture.storage.transition(ref, 'refining', 'in-progress'),
      ).rejects.toBeInstanceOf(NotFound)
    })
  })
}
