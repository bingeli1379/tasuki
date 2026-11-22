import { describe, expect, it } from 'vite-plus/test'
import { MAX_ATTACHMENT_BYTES } from '../../domain/attachment'
import type { WorkUnit } from '../../domain/work-unit'
import { storeStub } from '../../testing/store-stub'
import { trackerStub } from '../../testing/tracker-stub'
import { NotFound } from '../not-found'
import type { ItemPatch, NewAttachment, NewComment } from '../ports/tracker'
import type { Attachment } from '../../domain/attachment'
import { addAttachment } from './add-attachment'
import { addComment } from './add-comment'
import { deleteAttachment } from './delete-attachment'
import { getItem } from './get-item'
import { updateItem } from './update-item'

const item: WorkUnit = {
  ref: 'X-1',
  kind: 'item',
  title: 't',
  body: '',
  status: 'refining',
  labels: [],
  version: '1',
}

describe('getItem', () => {
  it('returns the item with its comments, attachments, tasks and Runs', async () => {
    const task = (ref: string): WorkUnit => ({
      ...item,
      ref,
      kind: 'task',
      parent: 'X-1',
      status: 'to-do',
      origin: 'splitter',
    })
    const detail = await getItem(
      trackerStub({
        get: () => Promise.resolve(item),
        comments: () => Promise.resolve([]),
        attachments: () => Promise.resolve([]),
        children: () => Promise.resolve([task('X-2'), task('X-3')]),
        dependencies: () => Promise.resolve([{ task: 'X-3', blockedBy: 'X-2' }]),
      }),
      storeStub({ runsFor: () => Promise.resolve([]) }),
      'X-1',
    )
    expect(detail).toEqual({
      item,
      comments: [],
      attachments: [],
      tasks: [
        { ...task('X-2'), blockedBy: [] },
        { ...task('X-3'), blockedBy: ['X-2'] },
      ],
      runs: [],
    })
  })

  it('a missing item is NotFound before anything else is read', async () => {
    await expect(
      getItem(
        trackerStub({ get: () => Promise.reject(new NotFound('X-9 does not exist')) }),
        storeStub({}),
        'X-9',
      ),
    ).rejects.toBeInstanceOf(NotFound)
  })
})

describe('updateItem', () => {
  const recording = (): { tracker: ReturnType<typeof trackerStub>; patches: ItemPatch[] } => {
    const patches: ItemPatch[] = []
    const tracker = trackerStub({
      updateItem: (_ref, _version, patch) => {
        patches.push(patch)
        return Promise.resolve({ ...item, ...patch })
      },
    })
    return { tracker, patches }
  }

  it('sends only the fields given, with the title trimmed', async () => {
    const { tracker, patches } = recording()
    await updateItem(tracker, { ref: 'X-1', expectedVersion: '1', title: '  New  ' })
    expect(patches).toEqual([{ title: 'New' }])
  })

  it('rejects a blank title and an empty patch without touching the tracker', async () => {
    const { tracker, patches } = recording()
    await expect(
      updateItem(tracker, { ref: 'X-1', expectedVersion: '1', title: ' ' }),
    ).rejects.toThrow('title is required')
    await expect(updateItem(tracker, { ref: 'X-1', expectedVersion: '1' })).rejects.toThrow(
      'nothing to update',
    )
    expect(patches).toEqual([])
  })
})

describe('addComment', () => {
  it("writes a person's comment as a human note", async () => {
    const added: NewComment[] = []
    await addComment(
      trackerStub({
        get: () => Promise.resolve(item),
        addComment: (c) => {
          added.push(c)
          return Promise.resolve({ id: '1', createdAt: 'now', ...c })
        },
      }),
      { ref: 'X-1', body: 'looks good' },
    )
    expect(added).toEqual([{ target: 'X-1', author: 'human', kind: 'note', body: 'looks good' }])
  })

  it('rejects an empty comment', async () => {
    await expect(addComment(trackerStub({}), { ref: 'X-1', body: '  \n' })).rejects.toThrow(
      'comment is empty',
    )
  })
})

describe('addAttachment', () => {
  const recording = (): { tracker: ReturnType<typeof trackerStub>; added: NewAttachment[] } => {
    const added: NewAttachment[] = []
    const tracker = trackerStub({
      addAttachment: (target, a) => {
        added.push(a)
        return Promise.resolve({
          id: '1',
          target,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.data.byteLength,
          createdAt: 'now',
        })
      },
    })
    return { tracker, added }
  }
  const bytes = (n: number): Uint8Array => new Uint8Array(n)

  it('keeps only the last path segment of the name and defaults the type', async () => {
    const { tracker, added } = recording()
    await addAttachment(tracker, 'X-1', {
      filename: 'C:\\Users\\me\\shot.png',
      mimeType: '',
      data: bytes(3),
    })
    expect(added.map((a) => [a.filename, a.mimeType])).toEqual([
      ['shot.png', 'application/octet-stream'],
    ])
  })

  it('rejects an empty file and one over the size limit', async () => {
    const { tracker, added } = recording()
    await expect(
      addAttachment(tracker, 'X-1', { filename: 'a', mimeType: '', data: bytes(0) }),
    ).rejects.toThrow('file is empty')
    await expect(
      addAttachment(tracker, 'X-1', {
        filename: 'a',
        mimeType: '',
        data: bytes(MAX_ATTACHMENT_BYTES + 1),
      }),
    ).rejects.toThrow('larger than 10 MB')
    expect(added).toEqual([])
  })
})

describe('deleteAttachment', () => {
  const dot: Attachment = {
    id: '1',
    target: 'X-1',
    filename: 'dot.png',
    mimeType: 'image/png',
    size: 1,
    createdAt: '2026-11-21T00:00:00.000Z',
  }
  function setup(body: string) {
    const deleted: string[] = []
    const logged: NewComment[] = []
    const tracker = trackerStub({
      get: () => Promise.resolve({ ...item, body }),
      attachments: () => Promise.resolve([dot]),
      deleteAttachment: (_ref, id) => {
        deleted.push(id)
        return Promise.resolve()
      },
      addComment: (c) => {
        logged.push(c)
        return Promise.resolve({ ...c, id: 'c', createdAt: '' })
      },
    })
    return { tracker, deleted, logged }
  }

  it('deletes it and leaves a line saying so', async () => {
    // attachment:12 is another file, not this one.
    const t = setup('see ![other](attachment:12)')
    await deleteAttachment(t.tracker, 'X-1', '1')
    expect(t.deleted).toEqual(['1'])
    expect(t.logged).toEqual([
      { target: 'X-1', author: 'human', kind: 'system', body: 'Deleted attachment dot.png.' },
    ])
  })

  it('refuses while the body still shows it, so the body never has a broken image', async () => {
    const t = setup('before\n\n![dot.png](attachment:1)\n\nafter')
    await expect(deleteAttachment(t.tracker, 'X-1', '1')).rejects.toThrow(
      "X-1's body still shows dot.png; take it out of the body first",
    )
    expect(t.deleted).toEqual([])
    expect(t.logged).toEqual([])
  })

  it('is NotFound for an id the unit does not have', async () => {
    const t = setup('')
    await expect(deleteAttachment(t.tracker, 'X-1', '9')).rejects.toBeInstanceOf(NotFound)
    expect(t.deleted).toEqual([])
  })
})
