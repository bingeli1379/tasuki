// Who someone is comes from the auth plugin; what they may do is tasuki's own (D89).
export type Access = 'admin' | 'maintainer' | 'member'

export const ACCESS_LEVELS: readonly Access[] = ['admin', 'maintainer', 'member']

export interface Identity {
  userId: string
  displayName: string
}

export interface Account extends Identity {
  // What they type at the login page.
  username: string
  access: Access
  disabled: boolean
  createdAt: string
  // Who the outside system says this is, bound at the first sign in (auth-http, D90). Unset
  // for an account tasuki keeps, and for one an admin added that has not signed in yet.
  externalId?: string
}

export const MIN_PASSWORD_LENGTH = 8

export const isActiveAdmin = (a: Account): boolean => a.access === 'admin' && !a.disabled
