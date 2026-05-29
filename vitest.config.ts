import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Standalone Vitest config. NOT electron-vite's config (that one has
// main/preload/renderer sub-configs). We only re-declare what node-env unit
// tests need: the @renderer alias and a node environment.
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules/**', 'out/**', 'dist/**', 'release/**']
  }
})
