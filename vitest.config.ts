import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Standalone Vitest config. NOT electron-vite's config (that one has
// main/preload/renderer sub-configs). We only re-declare what node-env unit
// tests need: the @renderer alias and a node environment.
// The React plugin gives TSX component tests JSX transform; `.test.tsx`
// files run in jsdom (DOM rendering) while `.test.ts` stay in node.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
    globals: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules/**', 'out/**', 'dist/**', 'release/**']
  }
})
