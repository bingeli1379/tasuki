#!/usr/bin/env node
import type { Clock } from '@tasuki/core'
import { pauseCommand, resumeCommand, runDoctor, startEngine } from '@tasuki/server'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { init } from './init'

const clock: Clock = { now: () => new Date() }
const COMMANDS = ['init', 'start', 'doctor', 'pause', 'resume']

try {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: 'string', default: 'tasuki.config.jsonc' },
      kill: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  })
  const command = positionals[0] ?? 'start'
  if (!COMMANDS.includes(command))
    throw new Error(`unknown command ${command}: ${COMMANDS.join(', ')}`)
  if (command === 'init') await init(resolve(values.config))
  if (command === 'doctor') process.exit(await runDoctor(values.config, clock))
  if (command === 'pause') await pauseCommand(values.config, clock, values.kill)
  if (command === 'resume') await resumeCommand(values.config, clock)
  if (command === 'start') {
    // The build copies the board next to dist; a workspace that never built it runs without.
    const webDir = join(import.meta.dirname, '..', 'web')
    await startEngine(values.config, clock, existsSync(webDir) ? { webDir } : {})
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
