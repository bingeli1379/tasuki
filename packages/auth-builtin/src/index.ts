import { API_VERSION, definePlugin, type AuthPort, type Plugin, type StorePort } from '@tasuki/core'
import { randomUUID } from 'node:crypto'
import { hashPassword, verifyPassword } from './password'

export * from './password'

// Checked against when the username is unknown, so a wrong username takes as long as a
// wrong password and the timing does not tell which accounts exist.
const DECOY = hashPassword(randomUUID())

// The accounts and their password hashes live in the engine's store (D89).
export function createBuiltinAuth(store: StorePort): AuthPort {
  return {
    async login({ username, password }) {
      const account = await store.findAccount(username)
      const hash = account === undefined ? undefined : await store.passwordHash(account.userId)
      const ok = await verifyPassword(password, hash ?? (await DECOY))
      return ok && account !== undefined && hash !== undefined
        ? { userId: account.userId, displayName: account.displayName }
        : undefined
    },
    accounts: {
      async create(account) {
        return store.createAccount({
          userId: randomUUID(),
          username: account.username,
          displayName: account.displayName,
          access: account.access,
          passwordHash: await hashPassword(account.password),
        })
      },
      async setPassword(userId, password) {
        await store.setPasswordHash(userId, await hashPassword(password))
      },
    },
  }
}

const plugin: Plugin = definePlugin({
  name: '@tasuki/auth-builtin',
  apiVersion: API_VERSION,
  auth: (ctx) => createBuiltinAuth(ctx.store),
})

export default plugin
