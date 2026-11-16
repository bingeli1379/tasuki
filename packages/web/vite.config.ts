import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  plugins: [vue()],
  // E2E points each web dev server at its own engine.
  server: { proxy: { '/api': process.env['TASUKI_API_URL'] ?? 'http://127.0.0.1:8787' } },
})
