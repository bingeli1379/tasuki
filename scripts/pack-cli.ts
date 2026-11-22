// Packs the CLI and every package it ships with, and installs them from the tarballs into the
// folder given, the way npm will install @tasuki/cli once it is published (S14). Both the
// container image and verify-cli-install.ts take the CLI from here.
// Usage: node scripts/pack-cli.ts <folder>; the bin is then <folder>/node_modules/.bin/tasuki.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PACKAGES = [
  'core',
  'server',
  'sqlite',
  'jira-cloud',
  'claude-cli',
  'codex-cli',
  'fake-runner',
  'auth-builtin',
  'auth-http',
  'cli',
]

const target = process.argv[2]
if (target === undefined) throw new Error('usage: node scripts/pack-cli.ts <folder>')
const root = resolve(import.meta.dirname, '..')
const app = resolve(target)
const tarballs = join(app, 'tarballs')
mkdirSync(tarballs, { recursive: true })

const run = (cmd: string, args: string[], cwd: string): void => {
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] })
}

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
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], app)
