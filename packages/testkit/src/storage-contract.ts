import {
  EditConflict,
  InvalidInput,
  NotFound,
  StatusConflict,
  type StoragePort,
  type WorkUnit,
} from '@tasuki/core'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

export interface StorageFixture {
  storage: StoragePort
  teardown?: () => Promise<void>
}

// Every tracker plugin runs this suite. The fixture must map the item statuses `refining`,
// `ready-to-split` and `in-progress`, and the task statuses `to-do`, `in-progress` and `manual`.
// Trackers may already hold other items, so assertions look for what this suite created.
// A 1x1 PNG, so trackers that inspect uploads (Jira renders images) get a real image.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  ),
  (c) => c.charCodeAt(0),
)

// Markdown in the shape trackers write it back, so a round trip compares equal.
// A single newline is a line break, as people expect when they press Enter.
const MARKDOWN = [
  '# Heading',
  '',
  'Some **bold**, _em_, `code`, ~~gone~~ and [a link](https://example.com).',
  'second line, same paragraph',
  '',
  '- one',
  '- two',
  '  1. nested',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '> quoted',
].join('\n')

export function describeStorageContract(name: string, setup: () => Promise<StorageFixture>): void {
  // A remote tracker takes several round trips per test (create, re-read, transition).
  describe(`StoragePort contract: ${name}`, { timeout: 30_000 }, () => {
    let fixture: StorageFixture

    beforeAll(async () => {
      fixture = await setup()
    })
    afterAll(async () => {
      await fixture.teardown?.()
    }, 60_000)

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
            (await fixture.storage.list('item', ['refining'])).find((u) => u.ref === item.ref),
          { timeout: 10_000, interval: 500 },
        )
        .toEqual(item)
    })

    it('lists several statuses in one call, each unit under its own', async () => {
      const first = await fixture.storage.createItem({
        title: 'contract: list many',
        body: '',
        status: 'refining',
      })
      const second = await fixture.storage.transition(
        (
          await fixture.storage.createItem({
            title: 'contract: list many',
            body: '',
            status: 'refining',
          })
        ).ref,
        'refining',
        'ready-to-split',
      )
      await expect
        .poll(
          async () =>
            (await fixture.storage.list('item', ['refining', 'ready-to-split']))
              .filter((u) => u.ref === first.ref || u.ref === second.ref)
              .map((u) => [u.ref, u.status]),
          { timeout: 10_000, interval: 500 },
        )
        .toEqual([
          [first.ref, 'refining'],
          [second.ref, 'ready-to-split'],
        ])
      expect(await fixture.storage.list('item', [])).toEqual([])
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
      expect(moved).toEqual({ ...item, status: 'ready-to-split', version: moved.version })
      expect(moved.version).not.toBe(item.version)
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

    const newItem = (title: string, body = ''): Promise<WorkUnit> =>
      fixture.storage.createItem({ title: `contract: ${title}`, body, status: 'refining' })

    it('updateItem writes the fields given and leaves the rest', async () => {
      const item = await newItem('update', 'keep me')
      const updated = await fixture.storage.updateItem(item.ref, item.version, {
        title: 'contract: updated',
      })
      expect(updated).toMatchObject({ title: 'contract: updated', body: 'keep me' })
      expect(updated.version).not.toBe(item.version)
      expect(await fixture.storage.get(item.ref)).toEqual(updated)
    })

    it('updateItem from a version someone replaced is an EditConflict', async () => {
      const item = await newItem('edit conflict')
      await fixture.storage.updateItem(item.ref, item.version, { body: 'theirs' })

      const stale = fixture.storage.updateItem(item.ref, item.version, { body: 'mine' })
      await expect(stale).rejects.toBeInstanceOf(EditConflict)
      await expect(stale).rejects.toMatchObject({ current: { body: 'theirs' } })
      expect((await fixture.storage.get(item.ref)).body).toBe('theirs')
    })

    it('a markdown body round-trips unchanged', async () => {
      const item = await newItem('markdown', MARKDOWN)
      expect(item.body).toBe(MARKDOWN)
      expect((await fixture.storage.get(item.ref)).body).toBe(MARKDOWN)
    })

    it('comments come back oldest first with their author and kind', async () => {
      const item = await newItem('comments')
      const human = await fixture.storage.addComment({
        target: item.ref,
        author: 'human',
        kind: 'note',
        body: 'looks **good**',
      })
      await fixture.storage.addComment({
        target: item.ref,
        author: 'agent',
        kind: 'question',
        body: 'which locale?\nsecond line',
      })
      await fixture.storage.addComment({
        target: item.ref,
        author: 'engine',
        kind: 'system',
        body: 'run failed',
      })
      expect(human).toMatchObject({ target: item.ref, author: 'human', body: 'looks **good**' })

      const comments = await fixture.storage.comments(item.ref)
      expect(comments.map((c) => [c.author, c.kind, c.body])).toEqual([
        ['human', 'note', 'looks **good**'],
        ['agent', 'question', 'which locale?\nsecond line'],
        ['engine', 'system', 'run failed'],
      ])
      expect(comments[0]).toEqual(human)
    })

    it('comments and attachments leave the version alone', async () => {
      const item = await newItem('version')
      await fixture.storage.addComment({
        target: item.ref,
        author: 'human',
        kind: 'note',
        body: 'x',
      })
      await fixture.storage.addAttachment(item.ref, {
        filename: 'a.png',
        mimeType: 'image/png',
        data: PNG,
      })
      expect((await fixture.storage.get(item.ref)).version).toBe(item.version)
    })

    it('adds and removes one label at a time, leaving the others and the version', async () => {
      const item = await newItem('labels')
      expect((await fixture.storage.addLabel(item.ref, 'keep')).labels).toEqual(['keep'])
      const held = await fixture.storage.addLabel(item.ref, 'hold')
      expect([...held.labels].sort()).toEqual(['hold', 'keep'])
      expect((await fixture.storage.addLabel(item.ref, 'hold')).labels).toHaveLength(2)
      expect(held.version).toBe(item.version)
      expect((await fixture.storage.removeLabel(item.ref, 'hold')).labels).toEqual(['keep'])
      expect((await fixture.storage.removeLabel(item.ref, 'hold')).labels).toEqual(['keep'])
      expect((await fixture.storage.get(item.ref)).labels).toEqual(['keep'])
      await expect(fixture.storage.addLabel('NOPE-999999', 'hold')).rejects.toBeInstanceOf(NotFound)
    })

    it('an attachment is listed and reads back byte for byte', async () => {
      const item = await newItem('attachment')
      const added = await fixture.storage.addAttachment(item.ref, {
        filename: 'dot.png',
        mimeType: 'image/png',
        data: PNG,
      })
      expect(added).toMatchObject({
        target: item.ref,
        filename: 'dot.png',
        mimeType: 'image/png',
        size: PNG.byteLength,
      })
      expect(await fixture.storage.attachments(item.ref)).toEqual([added])

      const read = await fixture.storage.readAttachment(item.ref, added.id)
      expect(read.attachment).toEqual(added)
      expect([...read.data]).toEqual([...PNG])
    })

    it("another unit's attachment is NotFound", async () => {
      const owner = await newItem('attachment owner')
      const other = await newItem('attachment other')
      const added = await fixture.storage.addAttachment(owner.ref, {
        filename: 'dot.png',
        mimeType: 'image/png',
        data: PNG,
      })
      await expect(fixture.storage.readAttachment(other.ref, added.id)).rejects.toBeInstanceOf(
        NotFound,
      )
    })

    it('a body embedding its own attachment round-trips unchanged', async () => {
      const item = await newItem('embedded image')
      const added = await fixture.storage.addAttachment(item.ref, {
        filename: 'dot.png',
        mimeType: 'image/png',
        data: PNG,
      })
      const body = `before\n\n![dot.png](attachment:${added.id})\n\nafter`
      const updated = await fixture.storage.updateItem(item.ref, item.version, { body })
      expect(updated.body).toBe(body)
      expect((await fixture.storage.get(item.ref)).body).toBe(body)
    })

    describe('tasks', () => {
      const task = (title: string, blockedBy: string[] = [], status = 'to-do') => ({
        title,
        body: '',
        status,
        origin: 'splitter' as const,
        blockedBy,
      })

      it('an item without tasks has no children and no dependencies', async () => {
        const item = await newItem('no tasks')
        expect(await fixture.storage.children(item.ref)).toEqual([])
        expect(await fixture.storage.dependencies(item.ref)).toEqual([])
      })

      // A verdict is checked right after the agent made its tasks, so no waiting here.
      it('a created task is a child of its item at once, readable on its own', async () => {
        const item = await newItem('with tasks')
        const created = await fixture.storage.createTask(item.ref, task('first'))
        expect(created).toMatchObject({
          kind: 'task',
          parent: item.ref,
          title: 'first',
          status: 'to-do',
          origin: 'splitter',
        })
        const manual = await fixture.storage.createTask(item.ref, task('by hand', [], 'manual'))
        expect(manual.status).toBe('manual')
        expect(await fixture.storage.children(item.ref)).toEqual([created, manual])
        expect(await fixture.storage.get(created.ref)).toEqual(created)
      })

      it('records which task waits for which, at once', async () => {
        const item = await newItem('dependencies')
        const first = await fixture.storage.createTask(item.ref, task('first'))
        const second = await fixture.storage.createTask(item.ref, task('second', [first.ref]))
        expect(await fixture.storage.dependencies(item.ref)).toEqual([
          { task: second.ref, blockedBy: first.ref },
        ])
      })

      it('refuses to wait for something that is not a task of the same item', async () => {
        const item = await newItem('foreign blocker')
        const other = await newItem('other item')
        const foreign = await fixture.storage.createTask(other.ref, task('theirs'))
        await expect(
          fixture.storage.createTask(item.ref, task('mine', [foreign.ref])),
        ).rejects.toBeInstanceOf(InvalidInput)
        expect(await fixture.storage.children(item.ref)).toEqual([])
      })

      it('refuses a task under something that is not an item', async () => {
        const item = await newItem('parent of a task')
        const child = await fixture.storage.createTask(item.ref, task('child'))
        await expect(
          fixture.storage.createTask(child.ref, task('grandchild')),
        ).rejects.toBeInstanceOf(NotFound)
      })

      it('moves a task with the same compare-and-set as an item', async () => {
        const item = await newItem('task moves')
        const created = await fixture.storage.createTask(item.ref, task('move me'))
        const moved = await fixture.storage.transition(created.ref, 'to-do', 'in-progress')
        expect(moved.status).toBe('in-progress')
        await expect(
          fixture.storage.transition(created.ref, 'to-do', 'manual'),
        ).rejects.toBeInstanceOf(StatusConflict)
      })

      it('edits a task the same way as an item', async () => {
        const item = await newItem('task edits')
        const created = await fixture.storage.createTask(item.ref, task('before'))
        const edited = await fixture.storage.updateItem(created.ref, created.version, {
          title: 'after',
          body: 'More detail.',
        })
        expect(edited).toMatchObject({ ref: created.ref, title: 'after', body: 'More detail.' })
        expect(edited.version).not.toBe(created.version)
      })

      it('deletes a task with its dependencies, at once, and never reuses its ref', async () => {
        const item = await newItem('task deletes')
        const first = await fixture.storage.createTask(item.ref, task('first'))
        const second = await fixture.storage.createTask(item.ref, task('second', [first.ref]))
        await fixture.storage.addComment({
          target: second.ref,
          author: 'human',
          kind: 'note',
          body: 'gone with it',
        })
        await fixture.storage.deleteTask(second.ref)
        expect((await fixture.storage.children(item.ref)).map((t) => t.ref)).toEqual([first.ref])
        await expect(fixture.storage.get(second.ref)).rejects.toBeInstanceOf(NotFound)
        // A task waiting for a deleted one no longer waits.
        const third = await fixture.storage.createTask(item.ref, task('third', [first.ref]))
        await fixture.storage.deleteTask(first.ref)
        expect(await fixture.storage.dependencies(item.ref)).toEqual([])
        expect([first.ref, second.ref]).not.toContain(third.ref)
        const fourth = await fixture.storage.createTask(item.ref, task('fourth'))
        expect([first.ref, second.ref, third.ref]).not.toContain(fourth.ref)
      })

      it('refuses to delete something that is not a task', async () => {
        const item = await newItem('not a task')
        await expect(fixture.storage.deleteTask(item.ref)).rejects.toBeInstanceOf(NotFound)
        expect((await fixture.storage.get(item.ref)).ref).toBe(item.ref)
      })

      it('lists tasks by status with their item, after the usual lag', async () => {
        const item = await newItem('listed tasks')
        const created = await fixture.storage.createTask(item.ref, task('listed'))
        await expect
          .poll(
            async () =>
              (await fixture.storage.list('task', ['to-do'])).find((u) => u.ref === created.ref),
            { timeout: 10_000, interval: 500 },
          )
          .toEqual(created)
      })
    })
  })
}
