// @ts-check
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  // Global ignores (object with only `ignores` = replaces .eslintignore).
  {
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'node_modules/**',
      'design-reference/**',
      // Harness-managed agent worktrees (each carries its own out/ build bundle).
      '.claude/**',
      // Vendored third-party source kept verbatim (ADR 0001 — perfect-freehand).
      'src/vendor/**',
      // Tooling configs are authored loosely and don't benefit from TS linting.
      '**/*.config.{js,cjs,mjs,ts,mts}',
      'eslint.config.mjs'
    ]
  },

  // Base JS + non-type-checked TypeScript recommended (fast; no projectService).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Defaults for every linted TS/TSX file.
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module'
    },
    rules: {
      // Mirror tsconfig noUnusedLocals/Params, but allow intentional _-prefixed
      // throwaways (used across main: `(_e, _lvl, message)`, `(_req, res)`).
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none'
        }
      ]
    }
  },

  // Main + preload run in Node/Electron-main: Node globals, console allowed.
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      'no-console': 'off'
    }
  },

  // Renderer: browser globals, React Hooks + Fast Refresh, console discouraged.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    languageOptions: {
      globals: { ...globals.browser }
    },
    rules: {
      // react-hooks v7 flat preset (rules-of-hooks + exhaustive-deps).
      ...reactHooks.configs.flat['recommended-latest'].rules,
      // react-refresh, Vite preset — warn so default-exported components
      // (App.tsx, smoke/*) don't error the build; still flags real breakers.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // App.tsx uses `// eslint-disable-next-line no-console` for its one log;
      // keep that disable meaningful by flagging stray console in the renderer.
      'no-console': 'warn'
    }
  },

  // Disable all formatting rules that would conflict with Prettier. MUST be last.
  eslintConfigPrettier
)
