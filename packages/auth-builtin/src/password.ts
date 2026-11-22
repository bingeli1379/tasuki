import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

const scryptAsync = (password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(password, salt, KEY_LENGTH, options, (e, key) => (e ? reject(e) : resolve(key))),
  )

const KEY_LENGTH = 64
// Node's defaults; the parameters travel in the hash, so raising them later still verifies old ones.
const PARAMS = { N: 16384, r: 8, p: 1 }

// scrypt$N$r$p$salt$key, salt and key in base64.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, PARAMS)
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = hash.split('$')
  if (scheme !== 'scrypt' || salt === undefined || key === undefined) return false
  const expected = Buffer.from(key, 'base64')
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
