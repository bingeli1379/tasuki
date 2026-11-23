import type { Account } from '../../domain/account'
import { Forbidden } from '../forbidden'
import type { SettingsVersion, StorePort } from '../ports/store'

// What the instance runs on is the deployer's, so a maintainer who edits the flow does not
// reach it (D105).
export function assertEditsInstance(actor: Account): void {
  if (actor.access !== 'admin') throw new Forbidden('only an admin edits the instance settings')
}

// value is already checked by the engine; expected is the version the editor started from.
export async function saveInstance(
  store: StorePort,
  actor: Account,
  expected: number | undefined,
  value: unknown,
): Promise<SettingsVersion> {
  assertEditsInstance(actor)
  return store.saveSettings('instance', expected, value, actor.displayName)
}
