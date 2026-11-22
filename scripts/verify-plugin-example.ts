// Installs @tasuki/core and @tasuki/testkit from packed tarballs into a copy of
// examples/tracker-memory outside the workspace, the way a third-party plugin gets them,
// then typechecks, runs the contract, builds, and imports the built plugin.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'tasuki-plugin-example-'))
const tarballs = join(work, 'tarballs')
const app = join(work, 'app')
mkdirSync(tarballs)

const run = (cmd: string, args: string[], cwd: string): void => {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

for (const pkg of ['core', 'testkit'])
  run('pnpm', ['pack', '--pack-destination', tarballs], join(root, 'packages', pkg))
const tarball = (name: string): string => {
  const file = readdirSync(tarballs).find((f) => f.startsWith(`tasuki-${name}-`))
  if (file === undefined) throw new Error(`no tarball for @tasuki/${name}`)
  return `file:${join(tarballs, file)}`
}

cpSync(join(root, 'examples', 'tracker-memory'), app, {
  recursive: true,
  filter: (src) => !/[/\\](node_modules|dist)$/.test(src),
})
const manifestPath = join(app, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const core = tarball('core')
manifest.devDependencies['@tasuki/core'] = core
manifest.devDependencies['@tasuki/testkit'] = tarball('testkit')
// testkit asks for @tasuki/core by version, which is not on the registry yet.
manifest.overrides = { '@tasuki/core': core }
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

run('npm', ['install', '--no-audit', '--no-fund'], app)
run('npm', ['run', 'typecheck'], app)
run('npm', ['test'], app)
run('npm', ['run', 'build'], app)

const plugin = (await import(pathToFileURL(join(app, 'dist', 'index.js')).href)).default
if (plugin?.name !== 'tasuki-plugin-memory' || plugin.apiVersion !== 1 || !plugin.tracker)
  throw new Error('the built plugin does not export a definePlugin result with a tracker')
console.log(`plugin example verified in ${app}`)
