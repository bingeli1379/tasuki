// Packs the CLI and every package it ships with, installs them from the tarballs into a folder
// outside the workspace, then drives the installed `tasuki` against an instance folder that has
// nothing but a config: doctor, start, the board at /, pause and resume.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PACKAGES = [
  'core',
  'server',
  'sqlite',
  'jira-cloud',
  'claude-cli',
  'fake-runner',
  'auth-builtin',
  'auth-http',
  'cli',
]
const PORT = 8797

const root = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'tasuki-cli-install-'))
const tarballs = join(work, 'tarballs')
const app = join(work, 'app')
const instance = join(work, 'my-instance')
for (const dir of [tarballs, app, instance]) mkdirSync(dir)

const run = (cmd: string, args: string[], cwd: string): string =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

for (const pkg of PACKAGES)
  run('pnpm', ['pack', '--pack-destination', tarballs], join(root, 'packages', pkg))
const tarball = (name: string): string => {
  const file = readdirSync(tarballs).find((f) => f.startsWith(`tasuki-${name}-0`))
  if (file === undefined) throw new Error(`no tarball for @tasuki/${name}`)
  return `file:${join(tarballs, file)}`
}
// Each package asks for the others by version, which is not on the registry until S14.
const overrides = Object.fromEntries(PACKAGES.map((p) => [`@tasuki/${p}`, tarball(p)]))
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify({ private: true, dependencies: { '@tasuki/cli': tarball('cli') }, overrides }),
)
run('npm', ['install', '--no-audit', '--no-fund'], app)
const tasuki = join(app, 'node_modules', '.bin', 'tasuki')

writeFileSync(
  join(instance, 'tasuki.config.jsonc'),
  JSON.stringify({
    server: { port: PORT },
    poll: { intervalSeconds: 1 },
    agents: { fake: { plugin: '@tasuki/fake-runner', options: { seconds: 0 } } },
  }),
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
