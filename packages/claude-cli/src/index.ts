import {
  API_VERSION,
  definePlugin,
  type DoctorFinding,
  type OptionsForm,
  type Plugin,
  type RunExit,
  type RunSpec,
} from '@tasuki/core'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// What the agent may do without asking (D107): only allowedTools, the rest refused; whatever
// Claude's own classifier lets through; or everything, which only belongs in a container.
const PERMISSIONS = ['allowlist', 'auto', 'bypass'] as const
type Permissions = (typeof PERMISSIONS)[number]

interface ClaudeOptions {
  // The CLI to run; tests point it at a stand-in.
  command: string
  model?: string
  permissions: Permissions
  // Tools allowed on top of the tasuki MCP tools, in Claude Code's own syntax, e.g.
  // "Read", "Bash(git:*)". Under allowlist anything else is refused, since nobody is there to
  // approve (D35).
  allowedTools: string[]
  // Claude Code settings passed with --settings, e.g. hooks and permissions.deny (D107).
  settings?: Record<string, unknown>
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
  // What doctor checks the agent sees at start: MCP servers connected, skills loaded.
  requires: { mcpServers: string[]; skills: string[] }
}

// The engine's environment holds the tracker's secrets (.env is loaded into it), and the
// agent must never see them (agent-contract.md). Only what the CLI needs to find itself,
// its login and a shell gets through; anything more goes in options.env.
const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM']

// How the CLI says a --resume id is unknown (claude 2.1.323, exit code 1).
const NO_SESSION = 'No conversation found with session ID'

// How long doctor waits for the CLI's init line, which comes once MCP servers have connected.
const INIT_TIMEOUT_MS = 60_000

// The variable each way of signing in is read from (code.claude.com/docs/en/authentication).
// Under -p an API key wins over the token, so a token config must carry no key.
const AUTH_ENV: Record<string, string> = {
  'api-key': 'ANTHROPIC_API_KEY',
  'oauth-token': 'CLAUDE_CODE_OAUTH_TOKEN',
}

// The variables of the ways not picked are dropped: the Agents page keeps a secret until it is
// replaced, and under -p an API key wins over the token.
function authEnv(auth: unknown, env: Record<string, string>): Record<string, string> {
  if (auth !== 'inherit-login' && (typeof auth !== 'string' || AUTH_ENV[auth] === undefined))
    throw new Error('options.auth must be inherit-login, api-key or oauth-token')
  const variable = AUTH_ENV[auth]
  if (variable !== undefined && (env[variable] ?? '') === '')
    throw new Error(`options.auth ${auth} needs options.env.${variable}`)
  const unpicked = [...Object.values(AUTH_ENV), 'ANTHROPIC_AUTH_TOKEN'].filter(
    (k) => k !== variable,
  )
  return Object.fromEntries(Object.entries(env).filter(([k]) => !unpicked.includes(k)))
}

function parseOptions(raw: unknown, configDir: string): ClaudeOptions {
  const o = (raw ?? {}) as Record<string, unknown>
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
  const permissions = o['permissions'] ?? 'allowlist'
  if (!PERMISSIONS.includes(permissions as Permissions))
    throw new Error(`options.permissions must be ${PERMISSIONS.join(', ')}`)
  const settings = o['settings']
  if (
    settings !== undefined &&
    (typeof settings !== 'object' || settings === null || Array.isArray(settings))
  )
    throw new Error('options.settings must be an object of Claude Code settings')
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
  const requires = o['requires'] ?? {}
  if (typeof requires !== 'object' || requires === null || Array.isArray(requires))
    throw new Error('options.requires must be an object')
  const required = (key: string): string[] => {
    const v = (requires as Record<string, unknown>)[key] ?? []
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string'))
      throw new Error(`options.requires.${key} must be a list of names`)
    return v as string[]
  }
  const model = o['model'] ?? undefined
  if (model !== undefined && model !== null && typeof model !== 'string')
    throw new Error('options.model must be a model name')
  return {
    command: typeof o['command'] === 'string' ? o['command'] : 'claude',
    ...(typeof model === 'string' ? { model } : {}),
    permissions: permissions as Permissions,
    allowedTools: strings('allowedTools'),
    ...(settings === undefined ? {} : { settings: settings as Record<string, unknown> }),
    env: authEnv(o['auth'] ?? 'inherit-login', env as Record<string, string>),
    inheritSettings: o['inheritSettings'] === true,
    plugins,
    mcpServers: mcpServers as Record<string, unknown>,
    ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
    requires: { mcpServers: required('mcpServers'), skills: required('skills') },
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
    ...PERMISSION_ARGS[options.permissions],
    '--allowedTools',
    ['mcp__tasuki', ...options.allowedTools].join(','),
    ...(options.settings === undefined ? [] : ['--settings', JSON.stringify(options.settings)]),
    '--mcp-config',
    JSON.stringify(mcp),
    ...('resume' in session ? ['--resume', session.resume] : ['--session-id', session.id]),
    ...(options.model === undefined ? [] : ['--model', options.model]),
    ...loading(options),
    ...(options.appendSystemPrompt === undefined
      ? []
      : ['--append-system-prompt', options.appendSystemPrompt]),
  ]
}

// Each way of permitting in claude's own flags (D107). Nobody is there to answer a prompt, so
// auto denies whatever its classifier would have asked about.
const PERMISSION_ARGS: Record<Permissions, string[]> = {
  allowlist: ['--permission-mode', 'dontAsk'],
  auto: ['--permission-mode', 'auto', '--permission-prompts', 'none'],
  bypass: ['--permission-mode', 'bypassPermissions'],
}

// The official installer (code.claude.com/docs/en/setup), shown when the CLI is missing; tasuki
// never runs it itself (D108).
const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'

// What the Agents page asks for (D111).
const FORM: OptionsForm = {
  fields: [
    {
      key: 'permissions',
      label: 'Permissions',
      type: 'select',
      required: true,
      choices: [
        { value: 'allowlist', label: 'Allowed tools only, anything else refused' },
        { value: 'auto', label: "Auto: Claude's classifier decides" },
        { value: 'bypass', label: 'Everything: only in a container' },
      ],
    },
    {
      key: 'allowedTools',
      label: 'Allowed tools',
      type: 'list',
      description:
        'One per line, in Claude Code syntax, e.g. Read or Bash(git:*). The tasuki tools are always allowed.',
    },
    {
      key: 'auth',
      label: 'Sign-in',
      type: 'select',
      choices: [
        { value: 'inherit-login', label: "This machine's claude login" },
        { value: 'api-key', label: 'An Anthropic API key' },
        { value: 'oauth-token', label: 'A token from claude setup-token' },
      ],
    },
    { key: 'env.ANTHROPIC_API_KEY', label: 'API key', type: 'secret' },
    {
      key: 'env.CLAUDE_CODE_OAUTH_TOKEN',
      label: 'OAuth token',
      type: 'secret',
      description: 'Run claude setup-token on a machine you are signed in on, and paste it here.',
    },
    { key: 'model', label: 'Model', type: 'text', placeholder: 'the CLI default' },
    {
      key: 'appendSystemPrompt',
      label: 'Base prompt',
      type: 'textarea',
      description: "This agent's standing instructions, under every rule's prompt.",
    },
    {
      key: 'plugins',
      label: 'Plugins',
      type: 'list',
      description: 'Claude Code plugin folders on this machine, one per line.',
    },
    {
      key: 'mcpServers',
      label: 'MCP servers',
      type: 'json',
      description: "In Claude Code's mcpServers shape. Their tools still go in Allowed tools.",
    },
    {
      key: 'settings',
      label: 'Settings',
      type: 'json',
      description: 'Claude Code settings for this agent, e.g. hooks and permissions.deny.',
    },
    {
      key: 'requires.skills',
      label: 'Required skills',
      type: 'list',
      description: 'Checked at start: each has to be loaded.',
    },
    {
      key: 'requires.mcpServers',
      label: 'Required MCP servers',
      type: 'list',
      description: 'Checked at start: each has to connect.',
    },
  ],
}

// What decides which skills and MCP servers the agent has, the same for a Run and for doctor.
const loading = (options: ClaudeOptions): string[] => [
  ...options.plugins.flatMap((dir) => ['--plugin-dir', dir]),
  ...(options.inheritSettings ? [] : ['--strict-mcp-config', '--setting-sources', '']),
]

function agentEnv(options: ClaudeOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PASSED_ENV) {
    const v = process.env[key]
    if (v !== undefined) env[key] = v
  }
  return Object.assign(env, options.env)
}

interface Init {
  mcp_servers?: { name: string; status: string }[]
  skills?: string[]
}

// Starts the CLI the way a Run would, without the tasuki server, reads the init line it prints
// before the model is asked anything, and ends it there.
function readInit(options: ClaudeOptions, cwd: string): Promise<Init | string> {
  return new Promise((resolve) => {
    const args = [
      '-p',
      'Reply with ok.',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(Object.keys(options.mcpServers).length === 0
        ? []
        : ['--mcp-config', JSON.stringify({ mcpServers: options.mcpServers })]),
      ...loading(options),
    ]
    const proc = spawn(options.command, args, {
      cwd,
      env: agentEnv(options),
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let buffered = ''
    const end = (result: Init | string): void => {
      clearTimeout(timer)
      try {
        if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
      resolve(result)
    }
    const timer = setTimeout(
      () => end(`printed no init line within ${INIT_TIMEOUT_MS / 1000}s`),
      INIT_TIMEOUT_MS,
    )
    proc.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        let event: { type?: string; subtype?: string } & Init
        try {
          event = JSON.parse(line) as typeof event
        } catch {
          continue
        }
        if (event.type === 'system' && event.subtype === 'init') return end(event)
      }
    })
    proc.on('error', (e) => end(e.message))
    proc.on('close', (code) => end(`exited with ${String(code)} before its init line`))
  })
}

const plugin: Plugin = definePlugin({
  name: '@tasuki/claude-cli',
  apiVersion: API_VERSION,
  forms: { runner: FORM },
  runner: (ctx, raw) => {
    const options = parseOptions(raw, ctx.configDir)
    return {
      async doctor() {
        const findings: DoctorFinding[] = []
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
        if (options.permissions === 'allowlist' && options.allowedTools.length === 0)
          findings.push({
            level: 'warning',
            message:
              'allowedTools is empty: the agent can call the tasuki tools and nothing else, so it cannot change a file',
          })
        const { mcpServers, skills } = options.requires
        if (mcpServers.length === 0 && skills.length === 0) return findings
        const init = await readInit(options, ctx.configDir)
        if (typeof init === 'string')
          return [...findings, { level: 'error', message: `${options.command} ${init}` }]
        for (const name of mcpServers) {
          const status = init.mcp_servers?.find((m) => m.name === name)?.status
          if (status !== 'connected')
            findings.push({
              level: 'error',
              message: `requires.mcpServers: ${name} is ${status === undefined ? 'not configured' : status}`,
            })
        }
        for (const name of skills)
          if (!(init.skills ?? []).includes(name))
            findings.push({ level: 'error', message: `requires.skills: ${name} is not loaded` })
        return findings
      },

      start(spec) {
        const log = createWriteStream(spec.logPath, { flags: 'a' })
        const env = Object.assign(agentEnv(options), {
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
