// Installs the CLI from its tarballs (pack-cli.ts) into a folder outside the workspace, then
// drives the installed `tasuki` against an instance folder that has
// nothing but a config: doctor, start, the board at /, pause and resume.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PORT = 8797

const root = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'tasuki-cli-install-'))
const app = join(work, 'app')
const instance = join(work, 'my-instance')
mkdirSync(instance)

const run = (cmd: string, args: string[], cwd: string): string =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

run('node', [join(root, 'scripts', 'pack-cli.ts'), app], root)
const tasuki = join(app, 'node_modules', '.bin', 'tasuki')

// Its own data folder: left out, it would be ~/.tasuki, the person's own instance (D105).
writeFileSync(
  join(instance, 'tasuki.config.jsonc'),
  JSON.stringify({ dataDir: './data', server: { port: PORT } }),
)
console.log(run(tasuki, ['doctor'], instance))

const engine = spawn(tasuki, ['start'], { cwd: instance, stdio: ['ignore', 'pipe', 'inherit'] })
let log = ''
engine.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()))
try {
  const base = `http://127.0.0.1:${PORT}`
  for (let i = 0; !log.includes('tasuki listening'); i++) {
    if (i > 100 || engine.exitCode !== null) throw new Error(`the engine did not start:\n${log}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  const page = await fetch(`${base}/`)
  const html = await page.text()
  if (!page.ok || !html.includes('<title>Tasuki</title>'))
    throw new Error(`/ is not the board: ${page.status}`)
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
  if (script === undefined || !(await fetch(`${base}${script}`)).ok)
    throw new Error(`the board's script ${script} is not served`)

  console.log(run(tasuki, ['pause', '--kill'], instance))
  const board = async (): Promise<{ paused: boolean }> =>
    (await fetch(`${base}/api/board`)).json() as Promise<{ paused: boolean }>
  if (!(await board()).paused) throw new Error('the engine does not see the pause')
  console.log(run(tasuki, ['resume'], instance))
  if ((await board()).paused) throw new Error('the engine does not see the resume')
} finally {
  engine.kill('SIGTERM')
}
console.log(log)
console.log(`cli install verified in ${work}`)
