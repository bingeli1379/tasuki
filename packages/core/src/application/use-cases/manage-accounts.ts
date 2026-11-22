import { isActiveAdmin, MIN_PASSWORD_LENGTH, type Access, type Account } from '../../domain/account'
import { Forbidden } from '../forbidden'
import { InvalidInput } from '../invalid-input'
import { NotFound } from '../not-found'
import type { AccountKeeper, AuthPort, NewPasswordAccount } from '../ports/auth'
import type { StorePort } from '../ports/store'

export interface AccountDeps {
  auth: AuthPort
  store: StorePort
}

function assertAdmin(actor: Account): void {
  if (actor.access !== 'admin') throw new Forbidden('only an admin manages accounts')
}

function keeper(auth: AuthPort): AccountKeeper {
  if (auth.accounts === undefined)
    throw new InvalidInput('the accounts live outside tasuki: change them there')
  return auth.accounts
}

export function assertPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new InvalidInput(`a password has at least ${MIN_PASSWORD_LENGTH} characters`)
}

async function target(store: StorePort, userId: string): Promise<Account> {
  const account = await store.getAccount(userId)
  if (account === undefined) throw new NotFound(`no account ${userId}`)
  return account
}

// With no admin left nobody could manage accounts again, short of editing the store.
async function assertKeepsAnAdmin(store: StorePort, leaving: Account): Promise<void> {
  if (!isActiveAdmin(leaving)) return
  const others = (await store.listAccounts()).filter(
    (a) => a.userId !== leaving.userId && isActiveAdmin(a),
  )
  if (others.length === 0) throw new InvalidInput(`${leaving.username} is the last admin`)
}

export async function listAccounts(store: StorePort, actor: Account): Promise<Account[]> {
  assertAdmin(actor)
  return store.listAccounts()
}

export async function createAccount(
  auth: AuthPort,
  actor: Account,
  account: NewPasswordAccount,
): Promise<Account> {
  assertAdmin(actor)
  const username = account.username.trim()
  if (username === '') throw new InvalidInput('username is empty')
  assertPassword(account.password)
  return keeper(auth).create({
    ...account,
    username,
    displayName: account.displayName.trim() || username,
  })
}

// Accounts from an outside system are added by username only, many at once when pasted from a
// list; the outside system checks the password and tells their name at the first sign in.
export async function addAccounts(
  { auth, store }: AccountDeps,
  actor: Account,
  usernames: readonly string[],
  access: Access,
): Promise<{ added: Account[]; existing: string[] }> {
  assertAdmin(actor)
  if (auth.accounts !== undefined)
    throw new InvalidInput('tasuki keeps these accounts: add each with a password')
  const wanted = [...new Set(usernames.map((u) => u.trim()).filter((u) => u !== ''))]
  if (wanted.length === 0) throw new InvalidInput('no usernames given')
  const added: Account[] = []
  const existing: string[] = []
  for (const username of wanted) {
    if ((await store.findAccount(username)) !== undefined) existing.push(username)
    else added.push(await store.createAccount({ username, displayName: username, access }))
  }
  return { added, existing }
}

// Deleting someone added from an outside system takes them off the list: they cannot sign in
// again until an admin adds them back (D90).
export async function deleteAccount(
  store: StorePort,
  actor: Account,
  userId: string,
): Promise<void> {
  assertAdmin(actor)
  if (userId === actor.userId) throw new InvalidInput('you cannot delete your own account')
  await assertKeepsAnAdmin(store, await target(store, userId))
  await store.deleteAccount(userId)
}

export async function setAccess(
  store: StorePort,
  actor: Account,
  userId: string,
  access: Access,
): Promise<Account> {
  assertAdmin(actor)
  const account = await target(store, userId)
  if (access !== 'admin') await assertKeepsAnAdmin(store, account)
  return store.updateAccount(userId, { access })
}

// A disabled account's sessions and API tokens stop working at once: every request checks it.
export async function setDisabled(
  store: StorePort,
  actor: Account,
  userId: string,
  disabled: boolean,
): Promise<Account> {
  assertAdmin(actor)
  const account = await target(store, userId)
  if (disabled) await assertKeepsAnAdmin(store, account)
  return store.updateAccount(userId, { disabled })
}

export async function resetPassword(
  { auth, store }: AccountDeps,
  actor: Account,
  userId: string,
  password: string,
): Promise<void> {
  assertAdmin(actor)
  assertPassword(password)
  await target(store, userId)
  await keeper(auth).setPassword(userId, password)
}

export async function changeOwnPassword(
  auth: AuthPort,
  actor: Account,
  current: string,
  next: string,
): Promise<void> {
  const accounts = keeper(auth)
  assertPassword(next)
  const me = await auth.login({ username: actor.username, password: current })
  if (me?.userId !== actor.userId) throw new InvalidInput('the current password is wrong')
  await accounts.setPassword(actor.userId, next)
}
