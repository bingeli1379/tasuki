import * as p from '@clack/prompts'
import { existsSync, writeFileSync } from 'node:fs'

class Cancelled extends Error {}

// Ctrl+C at any question ends init without writing anything.
function answered<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new Cancelled('init cancelled: nothing was written')
  return value as Exclude<T, symbol>
}

// `tasuki init`: asks what has to be known before the board opens and writes the config; the
// tracker and the agents are picked on the board (D105). An existing config is never
// overwritten.
export async function init(configPath: string): Promise<void> {
  if (existsSync(configPath)) throw new Error(`${configPath} already exists: init leaves it alone`)
  p.intro('tasuki init')
  try {
    const auth = answered(
      await p.select({
        message: 'Sign-in',
        options: [
          { value: false, label: 'none', hint: 'only this machine reaches the board' },
          {
            value: true,
            label: 'auth-builtin',
            hint: 'accounts kept in tasuki, the first admin from the setup token',
          },
        ],
      }),
    )
    const port = Number(
      answered(
        await p.text({
          message: 'Port',
          initialValue: '8787',
          validate: (v) =>
            /^\d+$/.test(v ?? '') && Number(v) >= 1 && Number(v) <= 65535
              ? undefined
              : 'a port number',
        }),
      ),
    )
    const lines = [
      '{',
      '  // Written by tasuki init. Relative paths resolve against this folder; ${VAR} expands',
      '  // from the environment and the .env next to this file. The tracker, the agents, the',
      '  // poll interval and the limits are picked on the board, under the gear.',
      '  "version": 1,',
      '  "dataDir": "./data",',
      `  "server": { "host": "127.0.0.1", "port": ${port} },`,
      ...(auth
        ? ['  "auth": { "plugin": "@tasuki/auth-builtin", "session": { "ttl": "7d" } },']
        : []),
      '}',
    ]
    writeFileSync(configPath, `${lines.join('\n')}\n`)
    p.note(configPath, 'Written')
    p.outro('next: tasuki doctor, then tasuki start')
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e
    p.cancel(e.message)
  }
}
