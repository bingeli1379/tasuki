import {
  API_VERSION,
  definePlugin,
  type OptionsForm,
  type Plugin,
  type RunExit,
  type RunSpec,
} from '@tasuki/core'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'

// What the agent may do without asking (D107). Codex has no per-tool list like claude's
// allowedTools: allowlist is its workspace-write sandbox with nothing approved past it; auto
// has its own reviewer approve; bypass drops the sandbox, which only belongs in a container.
const PERMISSIONS = ['allowlist', 'auto', 'bypass'] as const
type Permissions = (typeof PERMISSIONS)[number]

interface CodexOptions {
  // The CLI to run; tests point it at a stand-in.
  command: string
  model?: string
  permissions: Permissions
  // The agent's standing instructions (D77). Codex takes no system prompt on the command line,
  // so they follow the engine's prompt instead of sitting under it.
  appendSystemPrompt?: string
  // Passed to the spawned CLI only.
  env: Record<string, string>
  // false: the agent loads none of the machine's codex config.toml or rules, so a Run does the
  // same on any machine; the login in CODEX_HOME is still used. true: it loads them.
  inheritSettings: boolean
}

// The engine's environment holds the tracker's secrets (.env is loaded into it), and the agent
// must never see them (agent-contract.md). CODEX_HOME is where the CLI keeps its login.
const PASSED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TERM',
  'CODEX_HOME',
]

// The run token reaches the facade through this variable, so it is never on the command line.
const TOKEN_ENV = 'TASUKI_MCP_TOKEN'

// How the CLI says a resume id is unknown (codex-cli 0.169.0, exit code 1).
const NO_SESSION = 'no rollout found for thread id'

function parseOptions(raw: unknown): CodexOptions {
  const o = (raw ?? {}) as Record<string, unknown>
  const env = o['env'] ?? {}
  if (
    typeof env !== 'object' ||
    env === null ||
    Object.values(env).some((v) => typeof v !== 'string')
  )
    throw new Error('options.env must map names to strings')
  const auth = o['auth'] ?? 'inherit-login'
  if (auth === 'api-key') {
    if (((env as Record<string, string>)['CODEX_API_KEY'] ?? '') === '')
      throw new Error('options.auth api-key needs options.env.CODEX_API_KEY')
  } else if (auth !== 'inherit-login')
    throw new Error(
      'options.auth must be inherit-login or api-key: a subscription login is the auth.json in CODEX_HOME',
    )
  if (o['allowedTools'] !== undefined)
    throw new Error('options.allowedTools: codex has no per-tool list; set options.permissions')
  if (o['requires'] !== undefined)
    throw new Error('options.requires: doctor cannot check a codex agent for it yet')
  const permissions = o['permissions'] ?? 'allowlist'
  if (!PERMISSIONS.includes(permissions as Permissions))
    throw new Error(`options.permissions must be ${PERMISSIONS.join(', ')}`)
  const base = o['appendSystemPrompt']
  if (base !== undefined && typeof base !== 'string')
    throw new Error('options.appendSystemPrompt must be text')
  const model = o['model'] ?? undefined
  if (model !== undefined && model !== null && typeof model !== 'string')
    throw new Error('options.model must be a model name')
  return {
    command: typeof o['command'] === 'string' ? o['command'] : 'codex',
    ...(typeof model === 'string' ? { model } : {}),
    permissions: permissions as Permissions,
    ...(base === undefined || base === '' ? {} : { appendSystemPrompt: base }),
    // The key of the way not picked is dropped: the Agents page keeps a secret until replaced.
    env: Object.fromEntries(
      Object.entries(env as Record<string, string>).filter(
        ([k]) => auth === 'api-key' || k !== 'CODEX_API_KEY',
      ),
    ),
    inheritSettings: o['inheritSettings'] === true,
  }
}

// -c values are TOML; a JSON string is a valid TOML basic string.
const config = (key: string, value: string): string[] => ['-c', `${key}=${JSON.stringify(value)}`]

function codexArgs(options: CodexOptions, spec: RunSpec, resume: string | undefined): string[] {
  return [
    'exec',
    '--json',
    // The workspace is a plain folder until the agent clones into it.
    '--skip-git-repo-check',
    '--cd',
    spec.workspace,
    ...PERMISSION_ARGS[options.permissions],
    ...(options.model === undefined ? [] : ['--model', options.model]),
    ...(options.inheritSettings ? [] : ['--ignore-user-config', '--ignore-rules']),
    ...config('mcp_servers.tasuki.url', spec.mcp.url),
    ...config('mcp_servers.tasuki.bearer_token_env_var', TOKEN_ENV),
    ...(resume === undefined ? [] : ['resume', resume]),
    // The prompt comes on stdin.
    '-',
  ]
}

// Each way of permitting in codex's own flags (D107; codex-cli 0.169.0, not run for real: the
// author has no Codex account).
const PERMISSION_ARGS: Record<Permissions, string[]> = {
  allowlist: ['--sandbox', 'workspace-write', ...config('approval_policy', 'never')],
  auto: ['--approve-for-me'],
  bypass: ['--dangerously-bypass-approvals-and-sandbox'],
}

// The official install (github.com/openai/codex), shown when the CLI is missing; tasuki never
// runs it itself (D108).
const INSTALL = 'npm install -g @openai/codex'

// What the Agents page asks for (D111).
const FORM: OptionsForm = {
  fields: [
    {
      key: 'permissions',
      label: 'Permissions',
      type: 'select',
      required: true,
      choices: [
        { value: 'allowlist', label: 'Workspace only, anything more refused' },
        { value: 'auto', label: "Auto: codex's reviewer decides" },
        { value: 'bypass', label: 'Everything, no sandbox: only in a container' },
      ],
    },
    {
      key: 'auth',
      label: 'Sign-in',
      type: 'select',
      choices: [
        { value: 'inherit-login', label: "This machine's codex login" },
        { value: 'api-key', label: 'An OpenAI API key' },
      ],
    },
    { key: 'env.CODEX_API_KEY', label: 'API key', type: 'secret' },
    { key: 'model', label: 'Model', type: 'text', placeholder: 'the CLI default' },
    {
      key: 'appendSystemPrompt',
      label: 'Base prompt',
      type: 'textarea',
      description: "This agent's standing instructions, after every rule's prompt.",
    },
  ],
}

function agentEnv(options: CodexOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PASSED_ENV) {
    const v = process.env[key]
    if (v !== undefined) env[key] = v
  }
  return Object.assign(env, options.env)
}

const plugin: Plugin = definePlugin({
  name: '@tasuki/codex-cli',
  apiVersion: API_VERSION,
  forms: { runner: FORM },
  runner: (_ctx, raw) => {
    const options = parseOptions(raw)
    return {
      async doctor() {
        const version = spawnSync(options.command, ['--version'], {
          env: agentEnv(options),
          encoding: 'utf8',
        })
        if (version.error !== undefined || version.status !== 0)
          return [
            {
              level: 'error',
              message: `${options.command} does not run: ${version.error?.message ?? `--version exited with ${String(version.status)}`}`,
              fix: INSTALL,
            },
          ]
        return []
      },

      start(spec) {
        const log = createWriteStream(spec.logPath, { flags: 'a' })
        const env = Object.assign(agentEnv(options), {
          TASUKI_RUN_ID: spec.runId,
          TASUKI_TARGET: spec.target,
          TASUKI_MODE: spec.mode,
          TASUKI_WORKSPACE: spec.workspace,
          [TOKEN_ENV]: spec.mcp.token,
        })
        let child: ChildProcess | undefined
        let stopped = false

        const once = (resume: string | undefined) =>
          new Promise<{ exit: RunExit; stderr: string }>((resolve) => {
            let stderr = ''
            let buffered = ''
            // Its own process group, so terminate reaches whatever the CLI started too.
            const proc = spawn(options.command, codexArgs(options, spec, resume), {
              cwd: spec.workspace,
              env,
              detached: true,
              stdio: ['pipe', 'pipe', 'pipe'],
            })
            child = proc
            proc.stdin.on('error', () => {})
            proc.stdin.end(
              options.appendSystemPrompt === undefined
                ? spec.prompt
                : `${spec.prompt}\n\n${options.appendSystemPrompt}`,
            )
            proc.stdout.on('data', (chunk: Buffer) => {
              log.write(chunk)
              spec.onActivity()
              buffered += chunk.toString()
              const lines = buffered.split('\n')
              buffered = lines.pop() ?? ''
              // Codex names the session itself, in the first event, rather than taking one.
              for (const line of lines) {
                if (!line.includes('thread.started')) continue
                try {
                  const event = JSON.parse(line) as { type?: string; thread_id?: unknown }
                  if (event.type === 'thread.started' && typeof event.thread_id === 'string')
                    spec.onSession(event.thread_id)
                } catch {
                  // Not an event line.
                }
              }
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
          let result = await once(spec.resume)
          // The session is gone (cleared, another machine): start over rather than fail,
          // since the tracker holds what the agent needs (data-model.md).
          if (!stopped && spec.resume !== undefined && result.stderr.includes(NO_SESSION))
            result = await once(undefined)
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
