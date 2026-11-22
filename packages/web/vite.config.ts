import ui from '@nuxt/ui/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  plugins: [
    vue(),
    // Icons are bundled rather than fetched from the Iconify API, which an offline company
    // network cannot reach. One missing from the collection fails the build; one missing from
    // this list is fetched at run time, so every icon src uses is listed.
    ui({
      router: false,
      // A long title or description would otherwise squeeze the header under a long body.
      ui: { modal: { slots: { header: 'shrink-0' } } },
      colorMode: true,
      icon: {
        clientBundle: {
          icons: [
            'i-lucide-arrow-down',
            'i-lucide-arrow-up',
            'i-lucide-check',
            'i-lucide-chevron-down',
            'i-lucide-circle-user',
            'i-lucide-circle-x',
            'i-lucide-columns-3',
            'i-lucide-copy',
            'i-lucide-corner-down-right',
            'i-lucide-ellipsis',
            'i-lucide-eye',
            'i-lucide-file',
            'i-lucide-key-round',
            'i-lucide-loader-circle',
            'i-lucide-moon',
            'i-lucide-paperclip',
            'i-lucide-plus',
            'i-lucide-radar',
            'i-lucide-search',
            'i-lucide-settings',
            'i-lucide-sun',
            'i-lucide-trash-2',
            'i-lucide-user-check',
            'i-lucide-user-x',
            'i-lucide-x',
          ],
        },
      },
    }),
  ],
  // Nuxt UI's editor loads TipTap unbundled. Pre-bundling the TipTap packages the board
  // imports itself would give the page a second copy of ProseMirror, and the editor then
  // fails with "Adding different instances of a keyed plugin".
  optimizeDeps: { exclude: ['@tiptap/core', '@tiptap/extension-image'] },
  // E2E points each web dev server at its own engine.
  server: { proxy: { '/api': process.env['TASUKI_API_URL'] ?? 'http://127.0.0.1:8787' } },
})
