import { MAX_ATTACHMENT_BYTES, type Attachment } from '../../domain/attachment'
import type { Ref } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import type { NewAttachment, TrackerPort } from '../ports/tracker'

export async function addAttachment(
  tracker: TrackerPort,
  ref: Ref,
  file: NewAttachment,
): Promise<Attachment> {
  // Keep only the last path segment: browsers send a bare name, other clients may not.
  const filename = file.filename.split(/[/\\]/).pop()?.trim() ?? ''
  if (filename === '') throw new InvalidInput('filename is required')
  if (file.data.byteLength === 0) throw new InvalidInput('file is empty')
  if (file.data.byteLength > MAX_ATTACHMENT_BYTES)
    throw new InvalidInput(`file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
  return tracker.addAttachment(ref, {
    filename,
    mimeType: file.mimeType === '' ? 'application/octet-stream' : file.mimeType,
    data: file.data,
  })
}
