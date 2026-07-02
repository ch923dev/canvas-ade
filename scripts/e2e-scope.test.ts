import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain ESM build script, no .d.ts (runtime-only helper).
import { scopeForPaths } from './e2e-scope.mjs'

/**
 * Locks the path -> e2e-scope mapping (dx-audit MT-1 / PR-3). A selection bug
 * here means silently-untested pushes, so the safety contract — fail OPEN to
 * FULL — is asserted explicitly alongside the happy-path scoping.
 */
describe('scopeForPaths', () => {
  it('scopes a terminal board change to @core|@terminal', () => {
    expect(scopeForPaths(['src/renderer/src/canvas/boards/TerminalBoard.tsx'])).toBe(
      '@core|@terminal'
    )
  })

  it('scopes a planning element change to @core|@planning', () => {
    expect(scopeForPaths(['src/renderer/src/canvas/boards/planning/elements.ts'])).toBe(
      '@core|@planning'
    )
    expect(scopeForPaths(['src/vendor/perfect-freehand/getStroke.ts'])).toBe('@core|@planning')
  })

  it('scopes a browser/preview change to @core|@preview', () => {
    expect(scopeForPaths(['src/renderer/src/canvas/boards/BrowserBoard.tsx'])).toBe(
      '@core|@preview'
    )
    expect(scopeForPaths(['src/renderer/src/canvas/boards/usePreviewManager.ts'])).toBe(
      '@core|@preview'
    )
  })

  it('scopes a chrome change to @core|@chrome', () => {
    expect(scopeForPaths(['src/renderer/src/canvas/AppChrome.tsx'])).toBe('@core|@chrome')
    expect(scopeForPaths(['src/renderer/src/canvas/palette/CommandPalette.tsx'])).toBe(
      '@core|@chrome'
    )
    expect(scopeForPaths(['src/renderer/src/canvas/BackdropPicker.tsx'])).toBe('@core|@chrome')
  })

  it('scopes a placement-only change to @core', () => {
    expect(scopeForPaths(['src/renderer/src/canvas/hooks/useBoardPlacement.ts'])).toBe('@core')
    expect(scopeForPaths(['src/renderer/src/lib/placement.ts'])).toBe('@core')
  })

  it('unions multiple distinct areas in @core|@terminal|@preview|@planning|@chrome order', () => {
    expect(
      scopeForPaths([
        'src/renderer/src/canvas/boards/TerminalBoard.tsx',
        'src/renderer/src/canvas/boards/planning/elements.ts'
      ])
    ).toBe('@core|@terminal|@planning')
  })

  it('tags cross-area files (terminalPreview, FullViewModal) with both areas', () => {
    expect(scopeForPaths(['src/renderer/src/canvas/boards/terminalPreview.ts'])).toBe(
      '@core|@terminal|@preview'
    )
    expect(scopeForPaths(['src/renderer/src/canvas/FullViewModal.tsx'])).toBe(
      '@core|@preview|@chrome'
    )
  })

  describe('fails OPEN to FULL', () => {
    it.each([
      'src/renderer/src/canvas/Canvas.tsx', // shared canvas shell
      'src/renderer/src/canvas/BoardFrame.tsx', // board frame (all types)
      'src/renderer/src/store/canvasStore.ts', // store core
      'src/renderer/src/lib/boardSchema.ts', // schema
      'src/main/pty.ts', // main-process (cross-OS)
      'src/main/preview.ts', // main-process preview (cross-OS)
      'src/preload/index.ts', // preload bridge
      'e2e/terminal.e2e.ts', // an e2e spec
      'e2e/fixtures.ts', // the e2e fixtures
      'src/renderer/src/smoke/e2eHooks.ts', // smoke seam
      'package.json',
      'pnpm-lock.yaml',
      'playwright.config.ts',
      'scripts/e2e-scope.mjs', // the scope script itself
      'src/renderer/src/lib/somethingNew.ts' // unknown renderer path
    ])('-> FULL for %s', (path) => {
      expect(scopeForPaths([path])).toBe('FULL')
    })

    it('-> FULL when any changed path is cross-cutting (mixed change)', () => {
      expect(
        scopeForPaths([
          'src/renderer/src/canvas/boards/TerminalBoard.tsx',
          'src/renderer/src/store/canvasStore.ts'
        ])
      ).toBe('FULL')
    })

    it('-> FULL for empty / nothing-runtime input', () => {
      expect(scopeForPaths([])).toBe('FULL')
      expect(scopeForPaths(['docs/readme.md', 'misty-pines.png'])).toBe('FULL')
      expect(scopeForPaths([''])).toBe('FULL')
    })
  })

  it('ignores doc/asset paths but still scopes the code paths beside them', () => {
    expect(
      scopeForPaths(['docs/testing/TESTING.md', 'src/renderer/src/canvas/boards/TerminalBoard.tsx'])
    ).toBe('@core|@terminal')
  })

  it('tags Orchestration*/consent-flow modals with @mcp, not just @chrome (BUG-010)', () => {
    // The bare 'modal' keyword in `chrome` still matches these (they end in "Modal"), but the
    // scope MUST also include @mcp so the @mcp-tagged consent/sync e2e specs run.
    expect(scopeForPaths(['src/renderer/src/canvas/OrchestrationConsentModal.tsx'])).toBe(
      '@core|@chrome|@mcp'
    )
    expect(scopeForPaths(['src/renderer/src/canvas/OrchestrationSyncModal.tsx'])).toBe(
      '@core|@chrome|@mcp'
    )
    expect(scopeForPaths(['src/renderer/src/canvas/OrchestrationModals.tsx'])).toBe(
      '@core|@chrome|@mcp'
    )
  })

  it('scopes a renderer voice change to @core|@voice (V1: capture pipeline + store)', () => {
    expect(scopeForPaths(['src/renderer/src/voice/useVoiceCapture.ts'])).toBe('@core|@voice')
    expect(scopeForPaths(['src/renderer/src/voice/captureMath.ts'])).toBe('@core|@voice')
    expect(scopeForPaths(['src/renderer/src/store/voiceStore.ts'])).toBe('@core|@voice')
    // The MAIN half (voiceIpc.ts) stays FULL via the src/main/ cross-cutting rule.
    expect(scopeForPaths(['src/main/voiceIpc.ts'])).toBe('FULL')
  })

  it('normalises backslash paths', () => {
    expect(scopeForPaths(['src\\renderer\\src\\canvas\\boards\\TerminalBoard.tsx'])).toBe(
      '@core|@terminal'
    )
  })
})
