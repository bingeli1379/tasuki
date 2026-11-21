import { API_VERSION, definePlugin, type Plugin, type RunExit, type RunSpec } from '@tasuki/core'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface ClaudeOptions {
  // The CLI to run; tests point it at a stand-in.
  command: string
  model?: string
  // Tools allowed on top of the tasuki MCP tools, in Claude Code's own syntax, e.g.
  // "Read", "Bash(git:*)". Anything else is refused, since nobody is there to approve (D35).
  allowedTools: string[]
  // Passed to the spawned CLI only.
  env: Record<string, string>
  // false: the agent loads none of the machine's Claude settings, CLAUDE.md, hooks, plugins
  // or MCP servers, so a Run does the same on any machine. true: it loads them like an
  // interactive session would.
  inheritSettings: boolean
  // Plugin folders loaded for this agent alone, so a machine with nothing installed (a VM)
  // runs the same skills as a laptop.
  plugins: string[]
  // More MCP servers in Claude Code's own mcpServers shape. Their tools still need
  // allowedTools ("mcp__<name>"), like any other tool.
  mcpServers: Record<string, unknown>
  // The agent's standing instructions, under every rule's prompt (D77).
  appendSystemPrompt?: string
}

// The engine's environment holds the tracker's secrets (.env is loaded into it), and the
// agent must never see them (agent-contract.md). Only what the CLI needs to find itself,
// its login and a shell gets through; anything more goes in options.env.
const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM']

// How the CLI says a --resume id is unknown (claude 2.1.323, exit code 1).
const NO_SESSION = 'No conversation found with session ID'

function parseOptions(raw: unknown, configDir: string): ClaudeOptions {
  const o = (raw ?? {}) as Record<string, unknown>
  const auth = o['auth'] ?? 'inherit-login'
  if (auth !== 'inherit-login')
    throw new Error(`options.auth ${JSON.stringify(auth)} is not supported yet; use inherit-login`)
  const strings = (key: string): string[] => {
    const v = o[key] ?? []
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string'))
      throw new Error(`options.${key} must be a list of strings`)
    return v as string[]
  }
  const env = o['env'] ?? {}
  if (
    typeof env !== 'object' ||
    env === null ||
    Object.values(env).some((v) => typeof v !== 'string')
  )
    throw new Error('options.env must map names to strings')
  const plugins = strings('plugins').map((p) => {
    const dir = resolve(configDir, p)
    if (!existsSync(dir)) throw new Error(`options.plugins: ${dir} does not exist`)
    return dir
  })
  const mcpServers = o['mcpServers'] ?? {}
  if (typeof mcpServers !== 'object' || mcpServers === null || Array.isArray(mcpServers))
    throw new Error('options.mcpServers must map names to servers')
  if ('tasuki' in mcpServers) throw new Error('options.mcpServers: the name tasuki is taken')
  if (o['appendSystemPrompt'] !== undefined && o['appendSystemPromptFile'] !== undefined)
    throw new Error('options: set appendSystemPrompt or appendSystemPromptFile, not both')
  let appendSystemPrompt: string | undefined
  if (typeof o['appendSystemPrompt'] === 'string') appendSystemPrompt = o['appendSystemPrompt']
  else if (o['appendSystemPrompt'] !== undefined)
    throw new Error('options.appendSystemPrompt must be text')
  if (o['appendSystemPromptFile'] !== undefined) {
    if (typeof o['appendSystemPromptFile'] !== 'string')
      throw new Error('options.appendSystemPromptFile must be a path')
    const file = resolve(configDir, o['appendSystemPromptFile'])
    if (!existsSync(file)) throw new Error(`options.appendSystemPromptFile: ${file} does not exist`)
    appendSystemPrompt = readFileSync(file, 'utf8')
  }
  const model = o['model'] ?? undefined
  if (model !== undefined && model !== null && typeof model !== 'string')
    throw new Error('options.model must be a model name')
  return {
    command: typeof o['command'] === 'string' ? o['command'] : 'claude',
    ...(typeof model === 'string' ? { model } : {}),
    allowedTools: strings('allowedTools'),
    env: env as Record<string, string>,
    inheritSettings: o['inheritSettings'] === true,
    plugins,
    mcpServers: mcpServers as Record<string, unknown>,
    ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
  }
}

function claudeArgs(
  options: ClaudeOptions,
  spec: RunSpec,
  session: { resume: string } | { id: string },
): string[] {
  const mcp = {
    mcpServers: {
      ...options.mcpServers,
      tasuki: {
        type: 'http',
        url: spec.mcp.url,
        headers: { Authorization: `Bearer ${spec.mcp.token}` },
      },
    },
  }
  return [
    '-p',
    spec.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    // Whatever allowedTools does not cover is refused instead of waiting for a person.
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    ['mcp__tasuki', ...options.allowedTools].join(','),
    '--mcp-config',
    JSON.stringify(mcp),
    ...('resume' in session ? ['--resume', session.resume] : ['--session-id', session.id]),
    ...(options.model === undefined ? [] : ['--model', options.model]),
    ...options.plugins.flatMap((dir) => ['--plugin-dir', dir]),
    ...(options.appendSystemPrompt === undefined
      ? []
      : ['--append-system-prompt', options.appendSystemPrompt]),
    ...(options.inheritSettings ? [] : ['--strict-mcp-config', '--setting-sources', '']),
  ]
}

const plugin: Plugin = definePlugin({
  name: '@tasuki/claude-cli',
  apiVersion: API_VERSION,
  runner: (ctx, raw) => {
    const options = parseOptions(raw, ctx.configDir)
    return {
      start(spec) {
        const log = createWriteStream(spec.logPath, { flags: 'a' })
        const env: Record<string, string> = {}
        for (const key of PASSED_ENV) {
          const v = process.env[key]
          if (v !== undefined) env[key] = v
        }
        Object.assign(env, options.env, {
          TASUKI_RUN_ID: spec.runId,
          TASUKI_TARGET: spec.target,
          TASUKI_MODE: spec.mode,
          TASUKI_WORKSPACE: spec.workspace,
        })
        let child: ChildProcess | undefined
        let stopped = false

        const once = (session: { resume: string } | { id: string }) =>
          new Promise<{ exit: RunExit; stderr: string }>((resolve) => {
            spec.onSession('resume' in session ? session.resume : session.id)
            let stderr = ''
            // Its own process group, so terminate reaches whatever the CLI started too.
            const proc = spawn(options.command, claudeArgs(options, spec, session), {
              cwd: spec.workspace,
              env,
              detached: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
            child = proc
            proc.stdout.on('data', (chunk: Buffer) => {
              log.write(chunk)
              spec.onActivity()
            })
            proc.stderr.on('data', (chunk: Buffer) => {
              stderr += chunk.toString()
              log.write(chunk)
              spec.onActivity()
            })
            proc.on('error', (e) => {
              log.write(`could not start ${options.command}: ${e.message}\n`)
              resolve({ exit: { code: null, signal: null }, stderr })
            })
            proc.on('close', (code, signal) => resolve({ exit: { code, signal }, stderr }))
          })

        const exit = (async (): Promise<RunExit> => {
          let result = await once(
            spec.resume === undefined ? { id: randomUUID() } : { resume: spec.resume },
          )
          // The session is gone (cleared, another machine): start over rather than fail,
          // since the tracker holds what the agent needs (data-model.md).
          if (!stopped && spec.resume !== undefined && result.stderr.includes(NO_SESSION))
            result = await once({ id: randomUUID() })
          await new Promise((resolve) => log.end(resolve))
          return result.exit
        })()

        return {
          exit,
          terminate(signal) {
            stopped = true
            if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null)
              return
            try {
              process.kill(-child.pid, signal)
            } catch {
              // Already gone.
            }
          },
        }
      },
    }
  },
})

export default plugin
