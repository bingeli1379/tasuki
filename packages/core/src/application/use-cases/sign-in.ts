import { isActiveAdmin, type Account } from '../../domain/account'
import { InvalidInput } from '../invalid-input'
import type { AuthPort, Credentials, NewPasswordAccount } from '../ports/auth'
import type { StorePort } from '../ports/store'

export interface SignInDeps {
  auth: AuthPort
  store: StorePort
}

// The auth plugin says who it is; the store says what they may do. Someone an outside system
// lets in for the first time becomes a member, for an admin to raise (D89). A disabled
// account fails exactly like a wrong password.
export async function signIn(
  { auth, store }: SignInDeps,
  credentials: Credentials,
): Promise<Account | undefined> {
  const identity = await auth.login(credentials)
  if (identity === undefined) return undefined
  const known = await store.getAccount(identity.userId)
  const account =
    known === undefined
      ? await store.createAccount({
          userId: identity.userId,
          username: credentials.username,
          displayName: identity.displayName,
          access: 'member',
        })
      : known.displayName === identity.displayName
        ? known
        : await store.updateAccount(identity.userId, { displayName: identity.displayName })
  return account.disabled ? undefined : account
}

export async function needsSetup(store: StorePort): Promise<boolean> {
  return !(await store.listAccounts()).some(isActiveAdmin)
}

async function assertSetupOpen(store: StorePort): Promise<void> {
  if (!(await needsSetup(store))) throw new InvalidInput('there is an admin already')
}

// The first admin, while there is none. With the plugin keeping the accounts, it is a new
// account; otherwise the person who signed in through the outside system is raised.
export async function setUpFirstAdmin(
  { auth, store }: SignInDeps,
  first: Omit<NewPasswordAccount, 'access'> | Account,
): Promise<Account> {
  await assertSetupOpen(store)
  if ('userId' in first) return store.updateAccount(first.userId, { access: 'admin' })
  if (auth.accounts === undefined)
    throw new InvalidInput('sign in first: the accounts live outside tasuki')
  return auth.accounts.create({ ...first, access: 'admin' })
}
