import { VERDICTS, type Verdict } from '../../domain/run'
import { InvalidInput } from '../invalid-input'
import type { RuntimeStorePort } from '../ports/runtime-store'

export interface ReportResultInput {
  verdict: string
  summary: string
}

// The agent's last call in a Run. Only recorded here; the engine reads it once the process
// exits and decides the outcome then.
export async function reportResult(
  runtime: RuntimeStorePort,
  runId: string,
  input: ReportResultInput,
): Promise<void> {
  if (!VERDICTS.includes(input.verdict as Verdict))
    throw new InvalidInput(`verdict must be one of ${VERDICTS.join(', ')}`)
  await runtime.report(runId, input.verdict as Verdict, input.summary)
}
