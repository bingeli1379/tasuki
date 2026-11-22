import type { Attachment } from '../../domain/attachment'
import type { Run } from '../../domain/run'
import type { Ref } from '../../domain/work-unit'
import type { TrackerPort } from '../ports/tracker'
import { assertRunTarget } from './run-target'

// Every file on the Run's item and its tasks, whether a body links it or not: a person may
// attach the one thing that settles the job without mentioning it anywhere.
export async function listAgentAttachments(tracker: TrackerPort, run: Run): Promise<Attachment[]> {
  const tasks = await tracker.children(run.item)
  const lists = await Promise.all(
    [run.item, ...tasks.map((t) => t.ref)].map((ref) => tracker.attachments(ref)),
  )
  return lists.flat()
}

export async function readAgentAttachment(
  tracker: TrackerPort,
  run: Run,
  target: Ref,
  id: string,
): Promise<{ attachment: Attachment; data: Uint8Array }> {
  await assertRunTarget(tracker, run, target)
  return tracker.readAttachment(target, id)
}
