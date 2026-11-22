import { verdictsOf, type Rule } from '../../domain/rule'
import { InvalidInput } from '../invalid-input'
import type { StorePort } from '../ports/store'

export interface ReportResultInput {
  verdict: string
  summary: string
}

// The agent's last call in a Run. Only recorded here; the engine reads it once the process
// exits and decides the outcome then.
export async function reportResult(
  store: StorePort,
  runId: string,
  rule: Rule,
  input: ReportResultInput,
): Promise<void> {
  // Only what the rule declared: a verdict names an outcome, never a status (agent-contract.md).
  const verdicts = verdictsOf(rule)
  if (!verdicts.includes(input.verdict))
    throw new InvalidInput(`verdict must be one of ${verdicts.join(', ')}`)
  // The summary is the reason the item moves; every move the engine makes for an agent
  // carries one (D67).
  if (input.summary.trim() === '') throw new InvalidInput('summary is empty')
  await store.report(runId, input.verdict, input.summary.trim())
}
