import {
  addAttachment,
  addComment,
  createItem,
  getItem,
  listBoard,
  moveItem,
  updateItem,
  type RuntimeStorePort,
  type StatusMap,
  type StoragePort,
} from '@tasuki/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export interface McpDeps {
  storage: StoragePort
  runtime: RuntimeStorePort
  statuses: StatusMap
}

const json = (value: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

// The user's own AI client (Claude Code, Codex) acting as the user: the same use cases as
// the board, so whatever a person can do on the board this can do too (D57).
export function createMcpServer({ storage, runtime, statuses }: McpDeps): McpServer {
  const server = new McpServer({ name: 'tasuki', version: '0.0.0' })
  server.registerTool(
    'list_board',
    {
      description:
        'List the board: one column per item status in board order, each with its items, ' +
        'and `running`, the refs an agent is working on right now. ' +
        'Items created a few seconds ago may not be listed yet when the tracker is Jira.',
    },
    async () => json(await listBoard(storage, runtime, statuses.mapped('item'))),
  )
  server.registerTool(
    'create_item',
    {
      description: 'Create an item. It starts in the refining status. Returns the created item.',
      inputSchema: {
        title: z.string().describe('One line; must not be blank'),
        body: z.string().optional().describe('Plain text, may span lines'),
      },
    },
    async ({ title, body }) => json(await createItem(storage, { title, body: body ?? '' })),
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
        from: z.string().describe('Logical status the item is in now, e.g. refining'),
        to: z.string().describe('Logical status to move it to; must be a board column'),
      },
    },
    async (input) => json(await moveItem(storage, statuses.mapped('item'), input)),
  )
  server.registerTool(
    'get_item',
    {
      description:
        'Read one item: its fields (body is markdown), its comments oldest first, its ' +
        'attachments, and its runs newest first (each agent run on it: rule, attempt, outcome). ' +
        '`version` is what update_item needs. In the body, ![x](attachment:<id>) ' +
        'is an attachment of this item; [[embed:<label>|...]] is tracker content markdown ' +
        'cannot express (a Jira mention, table...): keep the token as is to keep that content.',
      inputSchema: { ref: z.string().describe('The item ref, e.g. TSK-12') },
    },
    async ({ ref }) => json(await getItem(storage, runtime, ref)),
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
        await updateItem(storage, {
          ref,
          expectedVersion: version,
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { body }),
        }),
      ),
  )
  server.registerTool(
    'add_comment',
    {
      description: 'Comment on an item as the user. Markdown. Returns the comment.',
      inputSchema: { ref: z.string(), body: z.string() },
    },
    async ({ ref, body }) => json(await addComment(storage, { ref, body })),
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
        await addAttachment(storage, ref, {
          filename,
          mimeType,
          data: new Uint8Array(Buffer.from(base64, 'base64')),
        }),
      ),
  )
  server.registerTool(
    'get_attachment',
    {
      description: "Read an item's attachment. Images come back as images; other files as base64.",
      inputSchema: { ref: z.string(), id: z.string() },
    },
    async ({ ref, id }) => {
      const { attachment, data } = await storage.readAttachment(ref, id)
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
