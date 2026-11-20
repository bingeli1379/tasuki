import ui from '@nuxt/ui/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  plugins: [vue(), ui({ router: false })],
  // Nuxt UI's editor loads TipTap unbundled. Pre-bundling the TipTap packages the board
  // imports itself would give the page a second copy of ProseMirror, and the editor then
  // fails with "Adding different instances of a keyed plugin".
  optimizeDeps: { exclude: ['@tiptap/core', '@tiptap/extension-image'] },
  // E2E points each web dev server at its own engine.
  server: { proxy: { '/api': process.env['TASUKI_API_URL'] ?? 'http://127.0.0.1:8787' } },
})
