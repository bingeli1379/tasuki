// vp check does not run the content mapper, so it still needs this to resolve .vue imports.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
