import { createItem, listBoard, moveItem, type StatusMap, type StoragePort } from '@tasuki/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export interface McpDeps {
  storage: StoragePort
  statuses: StatusMap
}

const json = (value: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

// The user's own AI client (Claude Code, Codex) acting as the user: the same use cases as
// the board, so whatever a person can do on the board this can do too (D57).
export function createMcpServer({ storage, statuses }: McpDeps): McpServer {
  const server = new McpServer({ name: 'tasuki', version: '0.0.0' })
  server.registerTool(
    'list_board',
    {
      description:
        'List the board: one column per item status in board order, each with its items. ' +
        'Items created a few seconds ago may not be listed yet when the tracker is Jira.',
    },
    async () => json({ columns: await listBoard(storage, statuses.mapped('item')) }),
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
  return server
}
