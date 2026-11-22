import {
  addAttachment,
  deleteAttachment,
  addComment,
  createItem,
  deleteItem,
  deleteTask,
  getItem,
  getTask,
  holdItem,
  listBoard,
  moveItem,
  moveTask,
  pauseEngine,
  releaseItem,
  requestRework,
  resumeEngine,
  stopRun,
  updateItem,
  updateTask,
  type StorePort,
  type TrackerPort,
} from '@tasuki/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { LiveFlow } from './flow'

export interface McpDeps {
  tracker: TrackerPort
  store: StorePort
  // Read once: a server lives for one request.
  flow: LiveFlow
}

const json = (value: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

// The user's own AI client (Claude Code, Codex) acting as the user: the same use cases as
// the board, so whatever a person can do on the board this can do too (D57).
export function createMcpServer({ tracker, store, flow }: McpDeps): McpServer {
  const { workflow, rules, holdLabel } = flow.current()
  const statuses = flow.statuses
  const server = new McpServer({ name: 'tasuki', version: '0.0.0' })
  const { entry, rework } = workflow.roles
  const noAgent = 'while no agent works on its item (stop_run first)'
  server.registerTool(
    'list_board',
    {
      description:
        'List the board: one column per item status in board order, each with its items ' +
        'and `handledBy`: engine when a rule picks items up from it, person when items wait ' +
        'for a person there, absent otherwise, and `outcomes`: the statuses a person can ' +
        'send the item to from there, the last the main choice (move_item, or ' +
        'request_rework when it is the rework status); ' +
        'and `roles`: which status new items start in (entry), where failed runs go ' +
        '(failure) and where work is sent back (rework, the status the rework rule watches); ' +
        'and `running`, the refs an agent is working on right now (`stopping`: of those, the ' +
        'ones told to stop and winding down), and `tasks`, per item ref ' +
        'that has tasks, how many are done out of how many, and `holdLabel`: an item with it ' +
        'among its labels is on hold, and no agent starts on it; and `paused`: while true the ' +
        'engine starts no agent on any item. ' +
        'Items created a few seconds ago may not be listed yet when the tracker is Jira.',
    },
    async () =>
      json(await listBoard(tracker, store, workflow, statuses.mapped('task'), rules, holdLabel)),
  )
  server.registerTool(
    'create_item',
    {
      description: `Create an item. It starts in the ${entry} status. Returns the created item.`,
      inputSchema: {
        title: z.string().describe('One line; must not be blank'),
        body: z.string().optional().describe('Plain text, may span lines'),
      },
    },
    async ({ title, body }) => json(await createItem(tracker, entry, { title, body: body ?? '' })),
  )
  server.registerTool(
    'move_item',
    {
      description:
        'Move an item to another status on the board. `from` is the status you last saw it in; ' +
        'if someone moved it since, the call fails and says where it is now, so read the board ' +
        'and decide again instead of retrying blindly. Moving an item into a status a rule ' +
        'watches starts an agent on it. Returns the moved item.',
      inputSchema: {
        ref: z.string().describe('The item ref, e.g. TSK-12'),
        from: z.string().describe(`Logical status the item is in now, e.g. ${entry}`),
        to: z.string().describe('Logical status to move it to; must be a board column'),
      },
    },
    async (input) => json(await moveItem(tracker, workflow, input)),
  )
  server.registerTool(
    'request_rework',
    {
      description:
        'Send finished work back to be reworked: leaves your feedback as a comment, then moves ' +
        `the item to ${rework ?? 'the rework status (none is set, so this fails)'}, where an agent reads it and makes new tasks for it (done ` +
        'tasks are never reopened). The feedback is all that agent has to go on, so say what ' +
        'is wrong and what you expect instead. `from` is as in move_item. Returns the moved item.',
      inputSchema: {
        ref: z.string().describe('The item ref'),
        from: z.string().describe('Logical status the item is in now'),
        feedback: z.string().describe('Markdown; must not be blank'),
      },
    },
    async (input) => json(await requestRework(tracker, workflow, input)),
  )
  server.registerTool(
    'hold_item',
    {
      description:
        `Put an item on hold (the ${holdLabel} label): no agent starts on it until it is ` +
        'released, and an agent working on it now is told to wind down; it is ended if it ' +
        'has not after a grace period. The item stays in its status. Returns the item.',
      inputSchema: { ref: z.string().describe('The item ref') },
    },
    async ({ ref }) => json(await holdItem({ tracker, store }, holdLabel, ref)),
  )
  server.registerTool(
    'release_item',
    {
      description:
        'Take an item off hold. From the next round agents may start on it again: an item ' +
        'whose agent was stopped picks up where its rule starts. Returns the item.',
      inputSchema: { ref: z.string().describe('The item ref') },
    },
    async ({ ref }) => json(await releaseItem(tracker, holdLabel, ref)),
  )
  server.registerTool(
    'stop_run',
    {
      description:
        'Stop the agent working on an item right now, and put the item on hold so none starts ' +
        'again until you release it. Nothing on the item moves: its status and tasks stay as ' +
        'the agent left them. Fails when no agent is running on it. Returns the item.',
      inputSchema: { ref: z.string().describe('The item ref') },
    },
    async ({ ref }) => json(await stopRun({ tracker, store }, holdLabel, ref)),
  )
  server.registerTool(
    'pause_engine',
    {
      description:
        'Pause the engine: no agent starts on any item until resume_engine. Agents working ' +
        'now finish on their own, unless kill is true: then each is stopped at once, its item ' +
        'stays where it is and carries on after resuming. Returns the runs it stopped.',
      inputSchema: {
        kill: z.boolean().optional().describe('Also stop every agent working now (default false)'),
      },
    },
    async ({ kill }) => json({ stopped: await pauseEngine(store, kill === true) }),
  )
  server.registerTool(
    'resume_engine',
    {
      description:
        'Resume a paused engine: from the next round agents start on items again, including ' +
        'those whose agent was stopped by pausing.',
    },
    async () => {
      await resumeEngine(store)
      return json({ ok: true })
    },
  )
  server.registerTool(
    'get_item',
    {
      description:
        'Read one item: its fields (body is markdown), its comments oldest first, its ' +
        'attachments, its tasks oldest first (status, origin, and blockedBy: the tasks each ' +
        'waits for), and its runs newest first (each agent run on it: rule, attempt, outcome). ' +
        "What a person can conclude in the item's status is that column's `outcomes` in " +
        'list_board. ' +
        '`version` is what update_item needs. In the body, ![x](attachment:<id>) ' +
        'is an attachment of this item; [[embed:<label>|...]] is tracker content markdown ' +
        'cannot express (a Jira mention, table...): keep the token as is to keep that content.',
      inputSchema: { ref: z.string().describe('The item ref, e.g. TSK-12') },
    },
    async ({ ref }) => json(await getItem(tracker, store, ref)),
  )
  server.registerTool(
    'update_item',
    {
      description:
        "Change an item's title and/or body. Pass the version from get_item; if someone " +
        'changed the item since, the call fails and returns it as it is now, so merge and retry ' +
        'instead of overwriting their change. Returns the updated item.',
      inputSchema: {
        ref: z.string(),
        version: z.string().describe('The version get_item returned'),
        title: z.string().optional(),
        body: z.string().optional().describe('Markdown; a single newline is a line break'),
      },
    },
    async ({ ref, version, title, body }) =>
      json(
        await updateItem(tracker, {
          ref,
          expectedVersion: version,
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { body }),
        }),
      ),
  )
  server.registerTool(
    'delete_item',
    {
      description:
        'Delete an item with all its tasks, comments and attachments. Cannot be undone. Fails ' +
        'while an agent works on it: stop_run first.',
      inputSchema: { ref: z.string().describe('The item ref') },
    },
    async ({ ref }) => {
      await deleteItem({ tracker, store }, ref)
      return json({ deleted: ref })
    },
  )
  server.registerTool(
    'get_task',
    {
      description:
        'Read one task: its fields (body is markdown, `parent` is its item), blockedBy (the ' +
        'tasks of the same item it waits for), and its comments oldest first. Comments by the ' +
        'engine say why the engine or an agent moved it. `version` is what update_task needs.',
      inputSchema: { ref: z.string().describe('The task ref, e.g. TSK-13') },
    },
    async ({ ref }) => json(await getTask(tracker, ref)),
  )
  server.registerTool(
    'move_task',
    {
      description:
        'Move a task as a person: take it over (to-do or in-progress to manual), hand it back ' +
        '(manual to to-do), finish it by hand (manual to done), or undo a done (done to to-do ' +
        'or manual, only while no agent works on its item). Nothing else. Each move leaves a ' +
        'line in its comments. Taking over a task an agent is on stops it from being dispatched again, ' +
        'but the agent may still finish it. `from` is the status you last saw it in; if it moved ' +
        'since, the call fails and says where it is now. Returns the moved task.',
      inputSchema: {
        ref: z.string().describe('The task ref'),
        from: z.string().describe('Logical task status it is in now, e.g. manual'),
        to: z.string().describe('manual, to-do or done'),
      },
    },
    async (input) => json(await moveTask({ tracker, store }, input)),
  )
  server.registerTool(
    'update_task',
    {
      description:
        `Change a task's title and/or body, ${noAgent}. Pass the ` +
        'version from get_task; if someone changed the task since, the call fails and returns ' +
        'it as it is now. Returns the updated task.',
      inputSchema: {
        ref: z.string(),
        version: z.string().describe('The version get_task returned'),
        title: z.string().optional(),
        body: z.string().optional().describe('Markdown'),
      },
    },
    async ({ ref, version, title, body }) =>
      json(
        await updateTask(
          { tracker, store },
          {
            ref,
            expectedVersion: version,
            ...(title === undefined ? {} : { title }),
            ...(body === undefined ? {} : { body }),
          },
        ),
      ),
  )
  server.registerTool(
    'delete_task',
    {
      description:
        `Delete a task, ${noAgent}. Its comments go with it, and ` +
        'tasks that waited for it no longer do. Cannot be undone.',
      inputSchema: { ref: z.string() },
    },
    async ({ ref }) => {
      await deleteTask({ tracker, store }, ref)
      return json({ deleted: ref })
    },
  )
  server.registerTool(
    'add_comment',
    {
      description: 'Comment on an item or a task as the user. Markdown. Returns the comment.',
      inputSchema: { ref: z.string(), body: z.string() },
    },
    async ({ ref, body }) => json(await addComment(tracker, { ref, body })),
  )
  server.registerTool(
    'add_attachment',
    {
      description:
        'Attach a file to an item (10 MB at most). To show an image in the body, put ' +
        '![name](attachment:<returned id>) in it with update_item. Returns the attachment.',
      inputSchema: {
        ref: z.string(),
        filename: z.string(),
        mimeType: z.string().describe('e.g. image/png'),
        base64: z.string().describe('The file content, base64'),
      },
    },
    async ({ ref, filename, mimeType, base64 }) =>
      json(
        await addAttachment(tracker, ref, {
          filename,
          mimeType,
          data: new Uint8Array(Buffer.from(base64, 'base64')),
        }),
      ),
  )
  server.registerTool(
    'delete_attachment',
    {
      description:
        "Delete an item's attachment. Cannot be undone. Fails while the body still shows it: " +
        'take the ![...](attachment:<id>) out with update_item first.',
      inputSchema: { ref: z.string(), id: z.string().describe('The attachment id') },
    },
    async ({ ref, id }) => {
      await deleteAttachment(tracker, ref, id)
      return json({ deleted: id })
    },
  )
  server.registerTool(
    'get_attachment',
    {
      description: "Read an item's attachment. Images come back as images; other files as base64.",
      inputSchema: { ref: z.string(), id: z.string() },
    },
    async ({ ref, id }) => {
      const { attachment, data } = await tracker.readAttachment(ref, id)
      const base64 = Buffer.from(data).toString('base64')
      return attachment.mimeType.startsWith('image/')
        ? { content: [{ type: 'image', data: base64, mimeType: attachment.mimeType }] }
        : {
            content: [
              { type: 'text', text: JSON.stringify(attachment) },
              {
                type: 'resource',
                resource: {
                  uri: `attachment:${attachment.id}`,
                  mimeType: attachment.mimeType,
                  blob: base64,
                },
              },
            ],
          }
    },
  )
  return server
}
