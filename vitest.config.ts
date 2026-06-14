import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig, configDefaults } from 'vitest/config'

// Two test tiers × two environments, as four projects (vitest 4 removed
// `environmentMatchGlobs` and the external `vitest.workspace.ts` file — both fold into
// `test.projects` here). The tier of a test = its filename, the environment = its
// extension:
//   unit          → src/**/*.test.{ts,tsx}              (excluding *.integration.*)
//   integration   → src/**/*.integration.test.{ts,tsx}
//   *.ts  → node (main-process / pure logic)   *.tsx → jsdom (React rendering)
// `pnpm test` runs all four; `pnpm test:unit` / `:integration` select by `--project`
// wildcard (`unit-*` / `integration-*`). Plugins / alias live here and are inherited by
// each project via `extends: true`.
const INTEGRATION = 'src/**/*.integration.test.{ts,tsx}'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    globals: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit-node',
          environment: 'node',
          // `scripts/**` carries pure build-tooling logic (e.g. e2e-scope.mjs)
          // that is unit-tested like any other node module.
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: [...configDefaults.exclude, INTEGRATION]
        }
      },
      {
        extends: true,
        test: {
          name: 'unit-dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          exclude: [...configDefaults.exclude, INTEGRATION]
        }
      },
      {
        extends: true,
        test: {
          name: 'integration-node',
          environment: 'node',
          include: ['src/**/*.integration.test.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'integration-dom',
          environment: 'jsdom',
          include: ['src/**/*.integration.test.tsx']
        }
      }
    ]
  }
})
