import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain ESM build script, no .d.ts (runtime-only helper).
import { scopeForPaths } from './e2e-scope.mjs'

/**
 * Locks the path -> e2e-scope mapping (dx-audit MT-1 / PR-3; re-scoped 2026-07-28).
 * A selection bug here means silently-untested pushes, so both halves of the safety
 * contract are asserted explicitly:
 *   * fail OPEN to FULL for anything cross-cutting or unrecognised,
 *   * emit NONE only for paths that provably cannot reach the running app.
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

  /**
   * 2026-07-28 ("push cheap / merge full"). `src/main/**` used to route blanket-FULL
   * because it is the cross-OS surface — but the Linux leg is now deferred to the
   * merge gate unconditionally, so blanket-FULL bought spec breadth, not OS coverage.
   * The well-partitioned MAIN subsystems therefore scope by area like the renderer.
   */
  describe('MAIN-process subsystems scope by area', () => {
    it.each([
      ['src/main/pty.ts', '@core|@terminal'],
      ['src/main/ptyHost/daemon.ts', '@core|@terminal'],
      ['src/main/terminalResume.ts', '@core|@terminal'],
      ['src/main/recapIpc.ts', '@core|@terminal'],
      ['src/main/previewOsr.ts', '@core|@preview'],
      ['src/main/previewOsrWidgets.ts', '@core|@preview'],
      ['src/main/localServer.ts', '@core|@preview'],
      ['src/main/voiceIpc.ts', '@core|@voice'],
      ['src/main/openaiTranscribe.ts', '@core|@voice'],
      ['src/main/mcpOrchestrator.ts', '@core|@mcp'],
      ['src/main/swarmLedger.ts', '@core|@mcp'],
      ['src/main/orchestrationLead.ts', '@core|@mcp'],
      // preload is per-domain too — the same reasoning applies to its bridge files
      ['src/preload/terminalApi.ts', '@core|@terminal'],
      ['src/preload/recapApi.ts', '@core|@terminal'],
      ['src/preload/voice.ts', '@core|@voice'],
      ['src/preload/mcpApi.ts', '@core|@mcp'],
      ['src/preload/swarm.ts', '@core|@mcp'],
      // shared MAIN⇄renderer contract modules follow their domain
      ['src/shared/mcpTypes.ts', '@core|@mcp'],
      ['src/shared/swarmLedgerTypes.ts', '@core|@mcp']
    ])('%s -> %s', (path, expected) => {
      expect(scopeForPaths([path])).toBe(expected)
    })

    it('leaves the shared MAIN core on FULL', () => {
      expect(scopeForPaths(['src/main/index.ts'])).toBe('FULL')
      expect(scopeForPaths(['src/main/quit.ts'])).toBe('FULL')
      expect(scopeForPaths(['src/main/windowSecurity.ts'])).toBe('FULL')
      expect(scopeForPaths(['src/main/projectIpc.ts'])).toBe('FULL')
      expect(scopeForPaths(['src/main/hooks/installer.ts'])).toBe('FULL')
    })

    it('leaves the shared preload bridge on FULL', () => {
      expect(scopeForPaths(['src/preload/index.ts'])).toBe('FULL')
      expect(scopeForPaths(['src/preload/index.d.ts'])).toBe('FULL')
      expect(scopeForPaths(['src/preload/authApi.ts'])).toBe('FULL')
      expect(scopeForPaths(['src/preload/projectTypes.ts'])).toBe('FULL')
    })
  })

  it('ignores the bench suite — it runs under a different Playwright config', () => {
    expect(scopeForPaths(['e2e/projectSwitch.bench.ts', 'e2e/benchSink.ts'])).toBe('NONE')
    expect(
      scopeForPaths(['e2e/terminalLoad.bench.ts', 'src/renderer/src/canvas/AppChrome.tsx'])
    ).toBe('@core|@chrome')
  })

  describe('fails OPEN to FULL', () => {
    it.each([
      'src/renderer/src/canvas/Canvas.tsx', // shared canvas shell
      'src/renderer/src/canvas/BoardFrame.tsx', // board frame (all types)
      'src/renderer/src/store/canvasStore.ts', // store core
      'src/renderer/src/lib/boardSchema.ts', // schema
      'src/main/index.ts', // MAIN entrypoint (shared core)
      'src/preload/index.ts', // preload bridge
      'e2e/terminal.e2e.ts', // an e2e spec (the hook targets spec FILES separately)
      'e2e/fixtures.ts', // the e2e fixtures
      'src/renderer/src/smoke/e2eHooks.ts', // smoke seam
      'package.json', // deps/scripts (version-only diffs are stripped by the hook)
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

    it('-> FULL for empty / unparseable input', () => {
      expect(scopeForPaths([])).toBe('FULL')
      expect(scopeForPaths([''])).toBe('FULL')
    })
  })

  /**
   * NONE = "nothing the e2e harness could observe changed" -> the caller skips e2e.
   * Only ever emitted for paths that cannot be bundled into, or read by, the running
   * app. The pre-commit trio + the Actions `check` job already cover all of these.
   */
  describe('emits NONE for provably non-runtime paths', () => {
    it.each([
      ['docs only', ['docs/readme.md', 'CLAUDE.md']],
      ['images', ['misty-pines.png', 'resources/icon.ico']],
      ['vitest unit specs', ['src/main/pty.test.ts', 'src/renderer/src/lib/placement.test.ts']],
      ['vitest integration specs', ['src/main/mcpConfirm.integration.test.ts']],
      ['test fixtures', ['src/main/__fixtures__/voice-librispeech-16k.wav']],
      ['CI workflow config', ['.github/workflows/pr.yml']],
      ['release/build tooling', ['scripts/release.mjs', 'scripts/gen-icon-win.mjs']],
      ['SCA + bench tooling', ['scripts/sca-audit.mjs', 'scripts/bench-baseline.mjs']],
      ['stt eval harness', ['scripts/stt-eval/run.mjs']],
      ['non-app trees', ['marketing/index.html', 'design-reference/project/DESIGN.md']],
      ['lint/format/vitest config', ['eslint.config.mjs', '.prettierrc', 'vitest.config.ts']],
      ['git metadata', ['.gitignore', '.gitattributes']]
    ])('%s -> NONE', (_label, paths) => {
      expect(scopeForPaths(paths)).toBe('NONE')
    })

    it('a unit-test edit beside a source edit still scopes the source', () => {
      expect(
        scopeForPaths(['src/main/pty.test.ts', 'src/renderer/src/canvas/boards/TerminalBoard.tsx'])
      ).toBe('@core|@terminal')
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
    // The voice ASSET generators feed runtime inputs, so they scope with voice too.
    expect(scopeForPaths(['scripts/gen-tts-manifest.mjs'])).toBe('@core|@voice')
    expect(scopeForPaths(['scripts/gen-voice-fillers.mjs'])).toBe('@core|@voice')
  })

  it('normalises backslash paths', () => {
    expect(scopeForPaths(['src\\renderer\\src\\canvas\\boards\\TerminalBoard.tsx'])).toBe(
      '@core|@terminal'
    )
  })
})
