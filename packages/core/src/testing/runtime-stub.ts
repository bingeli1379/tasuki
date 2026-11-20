import type { RuntimeStorePort } from '../application/ports/runtime-store'

// Test double: only the methods a test passes exist; calling any other one fails the test.
export function runtimeStub(methods: Partial<RuntimeStorePort>): RuntimeStorePort {
  return new Proxy(methods as RuntimeStorePort, {
    get: (target, key: string) =>
      key in target
        ? target[key as keyof RuntimeStorePort]
        : () => Promise.reject(new Error(`runtime.${key} was not expected`)),
  })
}
