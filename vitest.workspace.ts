import { defineWorkspace, configDefaults } from 'vitest/config'

// Two tiers, one shared base (vitest.config.ts). The tier of a test = its filename:
//   unit          → *.test.{ts,tsx}   (excluding *.integration.*)
//   integration   → *.integration.test.{ts,tsx}
// `pnpm test` runs both; `pnpm test:unit` / `pnpm test:integration` run one.
export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['src/**/*.test.{ts,tsx}'],
      exclude: [...configDefaults.exclude, 'src/**/*.integration.test.{ts,tsx}']
    }
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['src/**/*.integration.test.{ts,tsx}'],
      exclude: [...configDefaults.exclude]
    }
  }
])
