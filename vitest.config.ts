import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Shared Vitest base. Both workspace projects (unit, integration) extend this via
// vitest.workspace.ts, so plugins / alias / environment rules live in ONE place.
// `.test.tsx` files run in jsdom (DOM rendering); `.test.ts` stay in node.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [['**/*.tsx', 'jsdom']],
    globals: false
  }
})
