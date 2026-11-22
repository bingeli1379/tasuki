import { describe, expect, it } from 'vite-plus/test'
import type { Account } from '../../domain/account'
import { storeStub } from '../../testing/store-stub'
import { Forbidden } from '../forbidden'
import { InvalidInput } from '../invalid-input'
import type { AuthPort } from '../ports/auth'
import type { StorePort } from '../ports/store'
import { changeOwnPassword, createAccount, setAccess, setDisabled } from './manage-accounts'
import { needsSetup, setUpFirstAdmin, signIn } from './sign-in'

const account = (userId: string, over: Partial<Account> = {}): Account => ({
  userId,
  username: userId,
  displayName: userId,
  access: 'member',
  disabled: false,
  createdAt: '2026-11-22T00:00:00.000Z',
  ...over,
})

// Just enough of a store to hold accounts.
function accounts(...initial: Account[]): StorePort {
  const all = new Map(initial.map((a) => [a.userId, a]))
  return storeStub({
    getAccount: async (id) => all.get(id),
    listAccounts: async () => [...all.values()],
    createAccount: async (a) => {
      const created = account(a.userId, { ...a })
      all.set(a.userId, created)
      return created
    },
    updateAccount: async (id, change) => {
      const updated = { ...account(id), ...all.get(id), ...change }
      all.set(id, updated)
      return updated
    },
  })
}

const outside = (userId: string, displayName = userId): AuthPort => ({
  login: async ({ password }) => (password === 'right' ? { userId, displayName } : undefined),
})

describe('signIn', () => {
  it('makes someone the outside system lets in for the first time a member', async () => {
    const store = accounts()
    const me = await signIn(
      { auth: outside('u1', 'Eli'), store },
      { username: 'eli', password: 'right' },
    )
    expect(me).toMatchObject({
      userId: 'u1',
      username: 'eli',
      displayName: 'Eli',
      access: 'member',
    })
  })

  it('keeps the access an admin gave, and follows a renamed display name', async () => {
    const store = accounts(account('u1', { access: 'maintainer', displayName: 'Old' }))
    const me = await signIn(
      { auth: outside('u1', 'New'), store },
      { username: 'u1', password: 'right' },
    )
    expect(me).toMatchObject({ access: 'maintainer', displayName: 'New' })
  })

  it('turns a disabled account away like a wrong password', async () => {
    const store = accounts(account('u1', { disabled: true }))
    const auth = outside('u1')
    expect(await signIn({ auth, store }, { username: 'u1', password: 'right' })).toBeUndefined()
    expect(await signIn({ auth, store }, { username: 'u1', password: 'wrong' })).toBeUndefined()
  })
})

describe('setUpFirstAdmin', () => {
  it('raises the signed-in person while there is no admin, and only then', async () => {
    const store = accounts(account('u1'))
    expect(await needsSetup(store)).toBe(true)
    await setUpFirstAdmin({ auth: outside('u1'), store }, account('u1'))
    expect(await needsSetup(store)).toBe(false)
    await expect(setUpFirstAdmin({ auth: outside('u2'), store }, account('u2'))).rejects.toThrow(
      InvalidInput,
    )
  })

  it('counts a disabled admin as none', async () => {
    expect(await needsSetup(accounts(account('a', { access: 'admin', disabled: true })))).toBe(true)
  })
})

describe('managing accounts', () => {
  const admin = account('a', { access: 'admin' })

  it('is for admins only', async () => {
    const store = accounts(admin, account('m', { access: 'maintainer' }))
    await expect(
      setAccess(store, account('m', { access: 'maintainer' }), 'a', 'member'),
    ).rejects.toThrow(Forbidden)
  })

  it('never leaves the last admin demoted or disabled', async () => {
    const store = accounts(admin, account('m'))
    await expect(setAccess(store, admin, 'a', 'member')).rejects.toThrow('last admin')
    await expect(setDisabled(store, admin, 'a', true)).rejects.toThrow('last admin')
    await setAccess(store, admin, 'm', 'admin')
    expect((await setAccess(store, admin, 'a', 'member')).access).toBe('member')
  })

  it('creates accounts only when the plugin keeps them', async () => {
    const input = {
      username: 'new',
      displayName: '',
      password: 'long enough',
      access: 'member' as const,
    }
    await expect(createAccount(outside('x'), admin, input)).rejects.toThrow('outside tasuki')
  })

  it('wants the current password before changing it', async () => {
    let set = ''
    const auth: AuthPort = {
      ...outside('m'),
      accounts: {
        create: async () => account('x'),
        setPassword: async (_id, p) => void (set = p),
      },
    }
    const me = account('m')
    await expect(changeOwnPassword(auth, me, 'wrong', 'long enough')).rejects.toThrow('current')
    await expect(changeOwnPassword(auth, me, 'right', 'short')).rejects.toThrow('8 characters')
    await changeOwnPassword(auth, me, 'right', 'long enough')
    expect(set).toBe('long enough')
  })
})
