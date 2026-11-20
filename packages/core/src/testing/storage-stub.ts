import type { StoragePort } from '../application/ports/storage'

// Test double: only the methods a test passes exist; calling any other one fails the test.
export function storageStub(methods: Partial<StoragePort>): StoragePort {
  return new Proxy(methods as StoragePort, {
    get: (target, key: string) =>
      key in target
        ? target[key as keyof StoragePort]
        : () => Promise.reject(new Error(`storage.${key} was not expected`)),
  })
}
