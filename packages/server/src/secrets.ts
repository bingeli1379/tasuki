import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A secret option as the store keeps it: AES-256-GCM, iv, tag and text in base64 (D106).
const PREFIX = 'enc:v1:'

export interface Secrets {
  seal(text: string): string
  // Throws when the key is not the one it was sealed with.
  open(sealed: string): string
}

// TASUKI_SECRET_KEY wins; without it, a key made at the first start and kept in dataDir, so a
// leaked store alone gives nothing away, though a copy of the whole dataDir does (D106).
export function loadSecrets(dataDir: string): Secrets {
  const file = join(dataDir, 'secret.key')
  // Read when first needed, and made only by the first seal, so an instance with no secret,
  // or doctor reading one, writes no key.
  const keyFor = (create: boolean): Buffer => {
    const fromEnv = process.env['TASUKI_SECRET_KEY']
    if (fromEnv !== undefined && fromEnv !== '')
      return createHash('sha256').update(fromEnv).digest()
    if (!existsSync(file)) {
      if (!create) throw new Error(`no ${file}`)
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' })
    }
    return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
  }
  return {
    seal(text) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', keyFor(true), iv)
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return PREFIX + [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join(':')
    },
    open(sealed) {
      try {
        const [iv, tag, body] = sealed
          .slice(PREFIX.length)
          .split(':')
          .map((p) => Buffer.from(p, 'base64'))
        if (
          !sealed.startsWith(PREFIX) ||
          iv === undefined ||
          tag === undefined ||
          body === undefined
        )
          throw new Error('not sealed')
        const decipher = createDecipheriv('aes-256-gcm', keyFor(false), iv)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
      } catch {
        throw new Error(
          'a saved secret cannot be opened: the key in secret.key or TASUKI_SECRET_KEY is not the one it was saved with. Put the key back, or enter the secret again',
        )
      }
    },
  }
}
