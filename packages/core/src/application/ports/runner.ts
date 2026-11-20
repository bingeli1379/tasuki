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
}

export interface RunnerPort {
  start(spec: RunSpec): RunHandle
}
