import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  API_VERSION,
  definePlugin,
  isRunnable,
  VERDICTS,
  type Plugin,
  type RunExit,
  type TaskNode,
} from '@tasuki/core'
import { setTimeout as sleep } from 'node:timers/promises'

// A stand-in agent for trying the engine without an LLM. It talks to the MCP facade over
// HTTP like a real agent CLI would, so it gets nothing a third-party runner could not.
// A marker in the item's title picks what it does: [fake:needs_input] asks a question first,
// [fake:failed], [fake:blocked_manual], [fake:hang] never finishes, and [fake:no_tasks]
// claims success without making any. Anything else splits the item into two tasks, unless
// it already has some, and succeeds; [fake:manual] makes the second one manual.
// Executing, it walks every task it can run to done, then reports succeeded, or
// blocked_manual when manual tasks are left.
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
          const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
            const res = await client.callTool({ name, arguments: args })
            const text = (res.content as { text: string }[])[0]?.text ?? ''
            if (res.isError === true) throw new Error(`${name}: ${text}`)
            return JSON.parse(text) as T
          }
          try {
            const { title } = await call<{ title: string }>('get_item')
            const marker = /\[fake:([a-z_]+)\]/.exec(title)?.[1]
            if (marker === 'hang') await new Promise(() => {})
            await sleep(seconds * 1000)
            let verdict = VERDICTS.find((v) => v === marker) ?? 'succeeded'
            if (verdict === 'needs_input')
              await call('add_comment', {
                kind: 'question',
                body: 'The fake runner asks: what should this do?',
              })
            if (verdict === 'succeeded' && spec.mode === 'execute') {
              let tasks = await call<TaskNode[]>('list_tasks')
              for (let next = tasks.find((t) => isRunnable(t, tasks)); next !== undefined;) {
                for (const [status, reason] of [
                  ['in-progress', 'Starting on it.'],
                  ['in-review', 'Built it; checking the work.'],
                  ['done', 'The check passed.'],
                ])
                  await call('set_task_status', { task: next.ref, status, reason })
                tasks = await call<TaskNode[]>('list_tasks')
                next = tasks.find((t) => isRunnable(t, tasks))
              }
              if (tasks.some((t) => t.status === 'manual')) verdict = 'blocked_manual'
            } else if (verdict === 'succeeded' && marker !== 'no_tasks') {
              // Splitting again after being sent back keeps what is there (D30).
              if ((await call<unknown[]>('list_tasks')).length === 0) {
                const first = await call<{ ref: string }>('create_task', {
                  title: 'Prepare',
                  body: 'Made by the fake runner.',
                })
                await call('create_task', {
                  title: 'Build',
                  body: 'Made by the fake runner.',
                  blockedBy: [first.ref],
                  ...(marker === 'manual' ? { initialStatus: 'manual' } : {}),
                })
              }
            }
            await call('report_result', {
              verdict,
              summary: `The fake runner reported ${verdict}.`,
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
