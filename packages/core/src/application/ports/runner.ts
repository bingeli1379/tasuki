import type { RuleMode, RunExit } from '../../domain/rule'
import type { Ref } from '../../domain/work-unit'

export interface RunSpec {
  runId: string
  target: Ref
  mode: RuleMode
  // The item's workspace, already created. The agent's cwd.
  workspace: string
  // The engine's MCP facade for this Run. The token only reaches this Run's item and stops
  // working once the Run is over.
  mcp: { url: string; token: string }
}

export interface RunHandle {
  readonly exit: Promise<RunExit>
  // Ends the agent's whole process tree with this signal. The engine sends SIGTERM first and
  // SIGKILL once hardGraceSeconds pass without exit settling (stop-and-recovery.md).
  terminate(signal: 'SIGTERM' | 'SIGKILL'): void
}

export interface RunnerPort {
  start(spec: RunSpec): RunHandle
}
