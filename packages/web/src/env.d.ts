/// <reference types="vite-plus/client" />

// vp check does not understand .vue files, so it still needs this to resolve .vue imports.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
