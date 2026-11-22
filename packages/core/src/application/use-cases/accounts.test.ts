import { describe, expect, it } from 'vite-plus/test'
import type { Account } from '../../domain/account'
import { storeStub } from '../../testing/store-stub'
import { Forbidden } from '../forbidden'
import { InvalidInput } from '../invalid-input'
import type { AuthPort } from '../ports/auth'
import type { StorePort } from '../ports/store'
import {
  addAccounts,
  changeOwnPassword,
  createAccount,
  deleteAccount,
  setAccess,
  setDisabled,
} from './manage-accounts'
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
  let next = 0
  return storeStub({
    getAccount: async (id) => all.get(id),
    findAccount: async (username) => [...all.values()].find((a) => a.username === username),
    findAccountByExternalId: async (id) => [...all.values()].find((a) => a.externalId === id),
    listAccounts: async () => [...all.values()],
    createAccount: async (a) => {
      const userId = a.userId ?? `new-${++next}`
      const created = account(userId, { ...a, userId })
      all.set(userId, created)
      return created
    },
    deleteAccount: async (id) => void all.delete(id),
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
  it('lets in only someone an admin added, binding the outside id at the first sign in', async () => {
    const store = accounts(account('t1', { username: 'eli' }))
    const auth = outside('emp-1', 'Eli')
    expect(
      await signIn({ auth: outside('emp-9'), store }, { username: 'amy', password: 'right' }),
    ).toBeUndefined()
    expect(await signIn({ auth, store }, { username: 'eli', password: 'right' })).toMatchObject({
      userId: 't1',
      externalId: 'emp-1',
      displayName: 'Eli',
      access: 'member',
    })
    // Bound now: someone else the company later calls eli is not him.
    expect(
      await signIn({ auth: outside('emp-2'), store }, { username: 'eli', password: 'right' }),
    ).toBeUndefined()
  })

  it('keeps the access an admin gave, and follows a renamed display name', async () => {
    const store = accounts(
      account('t1', { access: 'maintainer', displayName: 'Old', externalId: 'emp-1' }),
    )
    const me = await signIn(
      { auth: outside('emp-1', 'New'), store },
      { username: 'whatever', password: 'right' },
    )
    expect(me).toMatchObject({ userId: 't1', access: 'maintainer', displayName: 'New' })
  })

  it('turns a disabled account away like a wrong password', async () => {
    const store = accounts(account('t1', { disabled: true, externalId: 'emp-1' }))
    const auth = outside('emp-1')
    expect(await signIn({ auth, store }, { username: 't1', password: 'right' })).toBeUndefined()
    expect(await signIn({ auth, store }, { username: 't1', password: 'wrong' })).toBeUndefined()
  })
})

describe('setUpFirstAdmin', () => {
  it('makes the person the outside system vouches for an admin, while there is none', async () => {
    const store = accounts()
    expect(await needsSetup(store)).toBe(true)
    expect(
      await setUpFirstAdmin(
        { auth: outside('emp-1', 'Eli'), store },
        { username: 'eli', password: 'wrong' },
      ),
    ).toBeUndefined()
    expect(
      await setUpFirstAdmin(
        { auth: outside('emp-1', 'Eli'), store },
        { username: 'eli', password: 'right' },
      ),
    ).toMatchObject({ username: 'eli', displayName: 'Eli', access: 'admin', externalId: 'emp-1' })
    expect(await needsSetup(store)).toBe(false)
    await expect(
      setUpFirstAdmin({ auth: outside('emp-2'), store }, { username: 'amy', password: 'right' }),
    ).rejects.toThrow(InvalidInput)
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

  it('adds outside accounts by username, skipping blanks, repeats and ones already there', async () => {
    const store = accounts(admin, account('m', { username: 'amy' }))
    const { added, existing } = await addAccounts(
      { auth: outside('x'), store },
      admin,
      [' bob ', '', 'amy', 'cat', 'bob'],
      'maintainer',
    )
    expect(added.map((a) => [a.username, a.access])).toEqual([
      ['bob', 'maintainer'],
      ['cat', 'maintainer'],
    ])
    expect(existing).toEqual(['amy'])
    const keeps: AuthPort = {
      ...outside('x'),
      accounts: { create: async () => account('x'), setPassword: async () => {} },
    }
    await expect(addAccounts({ auth: keeps, store }, admin, ['dan'], 'member')).rejects.toThrow(
      'with a password',
    )
  })

  it('deletes anyone but yourself and the last admin', async () => {
    const other = account('b', { access: 'admin' })
    const store = accounts(admin, other, account('m'))
    await expect(deleteAccount(store, admin, 'a')).rejects.toThrow('your own')
    await deleteAccount(store, admin, 'm')
    expect(await store.getAccount('m')).toBeUndefined()
    await setDisabled(store, admin, 'b', true)
    await expect(deleteAccount(store, other, 'a')).rejects.toThrow('last admin')
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
