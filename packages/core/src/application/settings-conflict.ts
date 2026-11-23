// A settings document was saved by someone else since it was read.
export class SettingsConflict extends Error {
  override name = 'SettingsConflict'
}
