import type { Access, Account, Identity } from '../../domain/account'

export interface Credentials {
  username: string
  password: string
}

export interface NewPasswordAccount {
  username: string
  displayName: string
  password: string
  access: Access
}

// The half of an auth plugin that only a plugin keeping the accounts itself has
// (auth-builtin). The board offers creating accounts and setting passwords when it is there.
export interface AccountKeeper {
  // Throws InvalidInput when the username is taken.
  create(account: NewPasswordAccount): Promise<Account>
  setPassword(userId: string, password: string): Promise<void>
}

// Answers who someone is, nothing more: access lives in the store (D89).
export interface AuthPort {
  // undefined when the credentials are wrong, without saying which half was.
  login(credentials: Credentials): Promise<Identity | undefined>
  accounts?: AccountKeeper
}
