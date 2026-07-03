import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],

  // Tauri expects a fixed dev server port (tauri.conf.json devUrl)
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // don't let the Rust build trigger frontend reloads
      ignored: ['**/src-tauri/**'],
    },
  },
})
