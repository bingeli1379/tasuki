import type { RunExit } from '../../domain/rule'
import type { Ref } from '../../domain/work-unit'
import type { DoctorFinding } from './doctor'

export interface RunSpec {
  runId: string
  target: Ref
  // The item's workspace, already created. The agent's cwd.
  workspace: string
  // The engine's MCP facade for this Run. The token only reaches this Run's item and stops
  // working once the Run is over.
  mcp: { url: string; token: string }
  // The rule's template with its variables filled in.
  prompt: string
  // A session of this agent on this item to pick up again (rule session per-item). When it
  // cannot be resumed the runner starts a new one instead of failing.
  resume?: string
  // Where the runner writes what the agent prints. The folder exists.
  logPath: string
  // The agent printed something: the Run is not stuck (lastActivityAt, D34).
  onActivity(): void
  // The session this Run ended up in, for a later Run to resume.
  onSession(id: string): void
}

export interface RunHandle {
  readonly exit: Promise<RunExit>
  // Ends the agent's whole process tree with this signal. The engine sends SIGTERM first and
  // SIGKILL once hardGraceSeconds pass without exit settling (stop-and-recovery.md).
  terminate(signal: 'SIGTERM' | 'SIGKILL'): void
}

export interface RunnerPort {
  start(spec: RunSpec): RunHandle
  // The agent preflight (doctor, check 9 and 10): the CLI is there, what the agent needs is
  // installed. Left out by a runner with nothing to check.
  doctor?(): Promise<DoctorFinding[]>
}
