import { describe, expect, it } from 'vite-plus/test'
import { MAX_ATTACHMENT_BYTES } from '../../domain/attachment'
import type { WorkUnit } from '../../domain/work-unit'
import { runtimeStub } from '../../testing/runtime-stub'
import { storageStub } from '../../testing/storage-stub'
import { NotFound } from '../not-found'
import type { ItemPatch, NewAttachment, NewComment } from '../ports/storage'
import { addAttachment } from './add-attachment'
import { addComment } from './add-comment'
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
  it('returns the item with its comments, attachments and Runs', async () => {
    const detail = await getItem(
      storageStub({
        get: () => Promise.resolve(item),
        comments: () => Promise.resolve([]),
        attachments: () => Promise.resolve([]),
      }),
      runtimeStub({ runsFor: () => Promise.resolve([]) }),
      'X-1',
    )
    expect(detail).toEqual({ item, comments: [], attachments: [], runs: [] })
  })

  it('a missing item is NotFound before anything else is read', async () => {
    await expect(
      getItem(
        storageStub({ get: () => Promise.reject(new NotFound('X-9 does not exist')) }),
        runtimeStub({}),
        'X-9',
      ),
    ).rejects.toBeInstanceOf(NotFound)
  })
})

describe('updateItem', () => {
  const recording = (): { storage: ReturnType<typeof storageStub>; patches: ItemPatch[] } => {
    const patches: ItemPatch[] = []
    const storage = storageStub({
      updateItem: (_ref, _version, patch) => {
        patches.push(patch)
        return Promise.resolve({ ...item, ...patch })
      },
    })
    return { storage, patches }
  }

  it('sends only the fields given, with the title trimmed', async () => {
    const { storage, patches } = recording()
    await updateItem(storage, { ref: 'X-1', expectedVersion: '1', title: '  New  ' })
    expect(patches).toEqual([{ title: 'New' }])
  })

  it('rejects a blank title and an empty patch without touching the tracker', async () => {
    const { storage, patches } = recording()
    await expect(
      updateItem(storage, { ref: 'X-1', expectedVersion: '1', title: ' ' }),
    ).rejects.toThrow('title is required')
    await expect(updateItem(storage, { ref: 'X-1', expectedVersion: '1' })).rejects.toThrow(
      'nothing to update',
    )
    expect(patches).toEqual([])
  })
})

describe('addComment', () => {
  it("writes a person's comment as a human note", async () => {
    const added: NewComment[] = []
    await addComment(
      storageStub({
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
    await expect(addComment(storageStub({}), { ref: 'X-1', body: '  \n' })).rejects.toThrow(
      'comment is empty',
    )
  })
})

describe('addAttachment', () => {
  const recording = (): { storage: ReturnType<typeof storageStub>; added: NewAttachment[] } => {
    const added: NewAttachment[] = []
    const storage = storageStub({
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
    return { storage, added }
  }
  const bytes = (n: number): Uint8Array => new Uint8Array(n)

  it('keeps only the last path segment of the name and defaults the type', async () => {
    const { storage, added } = recording()
    await addAttachment(storage, 'X-1', {
      filename: 'C:\\Users\\me\\shot.png',
      mimeType: '',
      data: bytes(3),
    })
    expect(added.map((a) => [a.filename, a.mimeType])).toEqual([
      ['shot.png', 'application/octet-stream'],
    ])
  })

  it('rejects an empty file and one over the size limit', async () => {
    const { storage, added } = recording()
    await expect(
      addAttachment(storage, 'X-1', { filename: 'a', mimeType: '', data: bytes(0) }),
    ).rejects.toThrow('file is empty')
    await expect(
      addAttachment(storage, 'X-1', {
        filename: 'a',
        mimeType: '',
        data: bytes(MAX_ATTACHMENT_BYTES + 1),
      }),
    ).rejects.toThrow('larger than 10 MB')
    expect(added).toEqual([])
  })
})
