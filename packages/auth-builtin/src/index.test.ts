import { openDatabase, migrate, STORE_MIGRATIONS, createSqliteStore } from '@tasuki/sqlite'
import { describe, expect, it } from 'vite-plus/test'
import { createBuiltinAuth } from './index'
import { hashPassword, verifyPassword } from './password'

function auth() {
  const db = openDatabase(':memory:')
  migrate(db, STORE_MIGRATIONS)
  const store = createSqliteStore(db, { now: () => new Date() })
  return { store, auth: createBuiltinAuth(store) }
}

describe('auth-builtin', () => {
  it('signs in with the password it was given, and nothing else', async () => {
    const { auth: a } = auth()
    const eli = await a.accounts?.create({
      username: 'eli',
      displayName: 'Eli',
      password: 'correct horse',
      access: 'admin',
    })
    expect(await a.login({ username: 'eli', password: 'correct horse' })).toEqual({
      userId: eli?.userId,
      displayName: 'Eli',
    })
    expect(await a.login({ username: 'eli', password: 'wrong horse' })).toBeUndefined()
    expect(await a.login({ username: 'nobody', password: 'correct horse' })).toBeUndefined()
  })

  it('a new password replaces the old one, and only a hash is stored', async () => {
    const { auth: a, store } = auth()
    const eli = await a.accounts?.create({
      username: 'eli',
      displayName: 'Eli',
      password: 'first one',
      access: 'member',
    })
    await a.accounts?.setPassword(String(eli?.userId), 'second one')
    expect(await a.login({ username: 'eli', password: 'first one' })).toBeUndefined()
    expect(await a.login({ username: 'eli', password: 'second one' })).toBeDefined()
    expect(await store.passwordHash(String(eli?.userId))).toMatch(/^scrypt\$16384\$8\$1\$/)
  })

  it('an account the store keeps no password for cannot sign in', async () => {
    const { auth: a, store } = auth()
    await store.createAccount({
      userId: 'x',
      username: 'ext',
      displayName: 'Ext',
      access: 'member',
    })
    expect(await a.login({ username: 'ext', password: '' })).toBeUndefined()
  })

  it('salts every hash', async () => {
    const [a, b] = [await hashPassword('same'), await hashPassword('same')]
    expect(a).not.toBe(b)
    expect(await verifyPassword('same', a)).toBe(true)
    expect(await verifyPassword('same', 'not a hash')).toBe(false)
  })
})
