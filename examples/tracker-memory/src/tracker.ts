import {
  EditConflict,
  InvalidInput,
  NotFound,
  StatusConflict,
  type Attachment,
  type Comment,
  type Dependency,
  type Kind,
  type NewAttachment,
  type PluginContext,
  type Ref,
  type TrackerPort,
  type WorkUnit,
} from '@tasuki/core'

interface Stored {
  unit: WorkUnit
  // The tracker's own status key; the port only ever speaks logical statuses.
  statusKey: string
  seq: number
}

export function createMemoryTracker(ctx: PluginContext, refPrefix: string): TrackerPort {
  const units = new Map<Ref, Stored>()
  const dependencies: Dependency[] = []
  const comments: Comment[] = []
  const attachments: { attachment: Attachment; data: Uint8Array }[] = []
  // Refs and versions only ever count up, so a deleted unit's ref is never handed out again.
  let nextRef = 1
  let nextVersion = 1
  let nextId = 1
  let nextSeq = 1

  const now = (): string => ctx.clock.now().toISOString()
  const view = (s: Stored): WorkUnit => ({
    ...s.unit,
    status: ctx.statuses.fromTracker(s.unit.kind, s.statusKey) ?? s.statusKey,
    labels: [...s.unit.labels],
  })
  const find = (ref: Ref, kind?: Kind): Stored => {
    const s = units.get(ref)
    if (s === undefined || (kind !== undefined && s.unit.kind !== kind))
      throw new NotFound(`${ref} not found`)
    return s
  }
  const insert = (unit: Omit<WorkUnit, 'ref' | 'version' | 'status'>, status: string): Stored => {
    const ref = `${refPrefix}-${nextRef++}`
    const s: Stored = {
      unit: { ...unit, ref, status, version: String(nextVersion++) },
      statusKey: ctx.statuses.toTracker(unit.kind, status),
      seq: nextSeq++,
    }
    units.set(ref, s)
    return s
  }
  const oldestFirst = (list: Stored[]): WorkUnit[] => list.sort((a, b) => a.seq - b.seq).map(view)
  const dropUnit = (ref: Ref): void => {
    units.delete(ref)
    for (let i = dependencies.length - 1; i >= 0; i--) {
      const d = dependencies[i]
      if (d !== undefined && (d.task === ref || d.blockedBy === ref)) dependencies.splice(i, 1)
    }
    for (let i = comments.length - 1; i >= 0; i--)
      if (comments[i]?.target === ref) comments.splice(i, 1)
    for (let i = attachments.length - 1; i >= 0; i--)
      if (attachments[i]?.attachment.target === ref) attachments.splice(i, 1)
  }
  const findAttachment = (target: Ref, id: string): number => {
    const i = attachments.findIndex((a) => a.attachment.target === target && a.attachment.id === id)
    if (i < 0) throw new NotFound(`attachment ${id} not found on ${target}`)
    return i
  }

  return {
    async list(kind, statuses) {
      const keys = new Set(statuses.map((s) => ctx.statuses.toTracker(kind, s)))
      return oldestFirst(
        [...units.values()].filter((s) => s.unit.kind === kind && keys.has(s.statusKey)),
      )
    },
    async get(ref) {
      return view(find(ref))
    },
    async children(item) {
      return oldestFirst([...units.values()].filter((s) => s.unit.parent === item))
    },
    async dependencies(item) {
      return dependencies.filter((d) => units.get(d.task)?.unit.parent === item)
    },
    async createItem({ title, body, status }) {
      return view(insert({ kind: 'item', title, body, labels: [] }, status))
    },
    async createTask(item, { title, body, status, origin, blockedBy }) {
      find(item, 'item')
      for (const ref of blockedBy)
        if (units.get(ref)?.unit.parent !== item)
          throw new InvalidInput(`${ref} is not a task of ${item}`)
      const s = insert({ kind: 'task', parent: item, title, body, labels: [], origin }, status)
      for (const ref of blockedBy) dependencies.push({ task: s.unit.ref, blockedBy: ref })
      return view(s)
    },
    async transition(ref, expectedFrom, to) {
      const s = find(ref)
      if (view(s).status !== expectedFrom) throw new StatusConflict(expectedFrom, view(s))
      s.statusKey = ctx.statuses.toTracker(s.unit.kind, to)
      s.unit.version = String(nextVersion++)
      return view(s)
    },
    async updateItem(ref, expectedVersion, patch) {
      const s = find(ref)
      if (s.unit.version !== expectedVersion) throw new EditConflict(view(s))
      if (patch.title !== undefined) s.unit.title = patch.title
      if (patch.body !== undefined) s.unit.body = patch.body
      s.unit.version = String(nextVersion++)
      return view(s)
    },
    async deleteTask(ref) {
      find(ref, 'task')
      dropUnit(ref)
    },
    async deleteItem(ref) {
      find(ref, 'item')
      for (const s of units.values()) if (s.unit.parent === ref) dropUnit(s.unit.ref)
      dropUnit(ref)
    },
    async addLabel(ref, label) {
      const s = find(ref)
      if (!s.unit.labels.includes(label)) s.unit.labels.push(label)
      return view(s)
    },
    async removeLabel(ref, label) {
      const s = find(ref)
      s.unit.labels = s.unit.labels.filter((l) => l !== label)
      return view(s)
    },
    async comments(target) {
      return comments.filter((c) => c.target === target)
    },
    async addComment({ target, author, authorName, kind, body }) {
      find(target)
      const comment: Comment = {
        id: String(nextId++),
        target,
        author,
        ...(authorName === undefined ? {} : { authorName }),
        kind,
        body,
        createdAt: now(),
      }
      comments.push(comment)
      return comment
    },
    async attachments(target) {
      return attachments.filter((a) => a.attachment.target === target).map((a) => a.attachment)
    },
    async addAttachment(target, { filename, mimeType, data }: NewAttachment) {
      find(target)
      const attachment: Attachment = {
        id: String(nextId++),
        target,
        filename,
        mimeType,
        size: data.byteLength,
        createdAt: now(),
      }
      attachments.push({ attachment, data: data.slice() })
      return attachment
    },
    async readAttachment(target, id) {
      const found = attachments[findAttachment(target, id)]
      if (found === undefined) throw new NotFound(`attachment ${id} not found on ${target}`)
      return { attachment: found.attachment, data: found.data.slice() }
    },
    async deleteAttachment(target, id) {
      attachments.splice(findAttachment(target, id), 1)
    },
  }
}
