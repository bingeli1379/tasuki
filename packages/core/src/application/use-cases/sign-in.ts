import { isActiveAdmin, type Account, type Identity } from '../../domain/account'
import { InvalidInput } from '../invalid-input'
import type { AuthPort, Credentials } from '../ports/auth'
import type { StorePort } from '../ports/store'

export interface SignInDeps {
  auth: AuthPort
  store: StorePort
}

// Only someone an admin added gets in through an outside system: adding them is the admin
// letting them in (D90). The first sign in binds the outside system's id to the account, so a
// username the company later hands to someone else does not carry the access over.
async function addedAccount(
  store: StorePort,
  identity: Identity,
  username: string,
): Promise<Account | undefined> {
  const bound = await store.findAccountByExternalId(identity.userId)
  if (bound !== undefined) return bound
  const added = await store.findAccount(username)
  if (added === undefined || added.externalId !== undefined) return undefined
  return store.updateAccount(added.userId, { externalId: identity.userId })
}

// The auth plugin says who it is; the store says what they may do (D89). Someone not on the
// list, or disabled, fails exactly like a wrong password.
export async function signIn(
  { auth, store }: SignInDeps,
  credentials: Credentials,
): Promise<Account | undefined> {
  const identity = await auth.login(credentials)
  if (identity === undefined) return undefined
  const account =
    auth.accounts === undefined
      ? await addedAccount(store, identity, credentials.username)
      : await store.getAccount(identity.userId)
  if (account === undefined || account.disabled) return undefined
  return account.displayName === identity.displayName
    ? account
    : store.updateAccount(account.userId, { displayName: identity.displayName })
}

export async function needsSetup(store: StorePort): Promise<boolean> {
  return !(await store.listAccounts()).some(isActiveAdmin)
}

// The first admin, while there is none, from the same username and password either way: a new
// account when the plugin keeps them, or the person the outside system vouches for.
// undefined when the outside system turns the credentials down.
export async function setUpFirstAdmin(
  { auth, store }: SignInDeps,
  first: Credentials,
): Promise<Account | undefined> {
  if (!(await needsSetup(store))) throw new InvalidInput('there is an admin already')
  const username = first.username.trim()
  if (username === '') throw new InvalidInput('username is empty')
  // An account tasuki keeps is shown by its username (D89).
  if (auth.accounts !== undefined)
    return auth.accounts.create({ ...first, username, displayName: username, access: 'admin' })
  const identity = await auth.login({ ...first, username })
  if (identity === undefined) return undefined
  const known = await store.findAccountByExternalId(identity.userId)
  if (known !== undefined) return store.updateAccount(known.userId, { access: 'admin' })
  return store.createAccount({
    username,
    displayName: identity.displayName,
    access: 'admin',
    externalId: identity.userId,
  })
}
