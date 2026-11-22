import type { StorePort } from '../application/ports/store'

// Test double: only the methods a test passes exist; calling any other one fails the test.
export function storeStub(methods: Partial<StorePort>): StorePort {
  return new Proxy(methods as StorePort, {
    get: (target, key: string) =>
      key in target
        ? target[key as keyof StorePort]
        : () => Promise.reject(new Error(`store.${key} was not expected`)),
  })
}
