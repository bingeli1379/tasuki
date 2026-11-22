import { ATTACHMENT_SCHEME } from '../../domain/attachment'
import type { Ref } from '../../domain/work-unit'
import { InvalidInput } from '../invalid-input'
import { NotFound } from '../not-found'
import type { TrackerPort } from '../ports/tracker'
import { logAction } from './log-action'

// An image the body still shows is not deleted: the body would show a broken image and the
// person would not know why. They take it out of the body first.
export async function deleteAttachment(tracker: TrackerPort, ref: Ref, id: string): Promise<void> {
  const attachment = (await tracker.attachments(ref)).find((a) => a.id === id)
  if (attachment === undefined) throw new NotFound(`${ref} has no attachment ${id}`)
  const unit = await tracker.get(ref)
  if (unit.body.includes(`](${ATTACHMENT_SCHEME}${id})`))
    throw new InvalidInput(
      `${ref}'s body still shows ${attachment.filename}; take it out of the body first`,
    )
  await tracker.deleteAttachment(ref, id)
  await logAction(tracker, ref, `Deleted attachment ${attachment.filename}.`)
}
