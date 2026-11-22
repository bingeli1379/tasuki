import { pauseEngine, resumeEngine, type Clock } from '@tasuki/core'
import { loadConfig } from './config'
import { loadStore, NO_STATUSES } from './plugin-loader'

async function storeOf(configPath: string, clock: Clock) {
  const config = loadConfig(configPath)
  return loadStore(config.store.plugin, config.store.options, config.configDir, {
    clock,
    configDir: config.configDir,
    dataDir: config.dataDir,
    statuses: NO_STATUSES,
  })
}

// `tasuki pause [--kill]` and `tasuki resume`: the same use cases the board calls (D73). They
// write the store the running engine reads every round, so no engine has to be reachable.
export async function pauseCommand(configPath: string, clock: Clock, kill: boolean): Promise<void> {
  const stopped = await pauseEngine(await storeOf(configPath, clock), kill)
  console.log('paused: no new Run starts until tasuki resume')
  if (kill) console.log(`stopping ${stopped.length} running Runs: ${stopped.join(', ') || 'none'}`)
}

export async function resumeCommand(configPath: string, clock: Clock): Promise<void> {
  await resumeEngine(await storeOf(configPath, clock))
  console.log('resumed')
}
