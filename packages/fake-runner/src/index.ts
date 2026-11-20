import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { API_VERSION, definePlugin, VERDICTS, type Plugin, type RunExit } from '@tasuki/core'
import { setTimeout as sleep } from 'node:timers/promises'

// A stand-in agent for trying the engine without an LLM. It talks to the MCP facade over
// HTTP like a real agent CLI would, so it gets nothing a third-party runner could not.
// A marker in the item's title picks what it does: [fake:needs_input], [fake:failed],
// [fake:blocked_manual], or [fake:hang] to never finish. Anything else succeeds.
const plugin: Plugin = definePlugin({
  name: '@tasuki/fake-runner',
  apiVersion: API_VERSION,
  runner: (_ctx, options) => {
    const seconds = (options as { seconds?: unknown }).seconds ?? 3
    if (typeof seconds !== 'number' || seconds < 0)
      throw new Error('options.seconds must be a number of seconds, 0 or more')
    return {
      start(spec) {
        const run = async (): Promise<void> => {
          const client = new Client({ name: 'tasuki-fake-runner', version: '0.0.0' })
          await client.connect(
            new StreamableHTTPClientTransport(new URL(spec.mcp.url), {
              requestInit: { headers: { Authorization: `Bearer ${spec.mcp.token}` } },
            }),
          )
          try {
            const read = await client.callTool({ name: 'get_item', arguments: {} })
            const text = (read.content as { text: string }[])[0]?.text ?? '{}'
            const { title } = JSON.parse(text) as { title: string }
            const marker = /\[fake:([a-z_]+)\]/.exec(title)?.[1]
            if (marker === 'hang') await new Promise(() => {})
            await sleep(seconds * 1000)
            const verdict = VERDICTS.find((v) => v === marker) ?? 'succeeded'
            await client.callTool({
              name: 'report_result',
              arguments: { verdict, summary: `The fake runner reported ${verdict}.` },
            })
          } finally {
            await client.close()
          }
        }
        // A real CLI that hits an error exits non-zero; so does this one.
        const exit = run().then(
          (): RunExit => ({ code: 0, signal: null }),
          (e: unknown): RunExit => {
            console.error(`fake runner on ${spec.target}: ${String(e)}`)
            return { code: 1, signal: null }
          },
        )
        return { exit }
      },
    }
  },
})

export default plugin
