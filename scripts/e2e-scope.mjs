// e2e scope selector (dx-audit MT-1 / PR-3).
//
// Maps a list of changed file paths -> either a Playwright `--grep` expression
// (a scoped subset of the e2e suite) or the literal string `FULL` (run every
// spec). The pre-push hook pipes its computed change-set to this script on
// stdin and uses the verdict to scope the Windows e2e leg; `scopeForPaths` is
// also unit-tested directly (it is a pure function of a path list).
//
// SAFETY CONTRACT — fail OPEN to FULL, never to a narrower set:
//   * any cross-cutting or cross-OS path (src/main, src/preload, e2e harness,
//     build/test config, the shared canvas shell, the store/schema) -> FULL,
//   * any renderer path that matches no known area -> FULL,
//   * an empty / unparseable input -> FULL.
// Only when EVERY changed (non-doc) path resolves to a known board-type area do
// we emit a scoped grep. A scoped verdict therefore implies "renderer-area only"
// — which is why the hook runs such pushes on the Windows leg alone (the Linux
// Docker leg, and the full matrix, are paid once per PR at the merge gate, and
// per-push whenever a LINUX_SENSITIVE path changes; see .githooks/pre-push).
//
// The tags mirror the e2e spec describe-title tags applied in this PR:
//   @core  @terminal  @preview  @planning  @chrome  @mcp  @voice
// `@core` is ALWAYS included in a scoped grep (boot / placement / recovery /
// isolation specs guard behaviour any board change can perturb).

/** Non-runtime paths that never affect the app under test — ignored entirely. */
const IGNORE = [/^docs\//, /\.md$/i, /\.(png|jpe?g|gif|webp|webm|mp4|svg|ico)$/i]

/**
 * Cross-cutting or cross-OS paths -> FULL. Checked FIRST so a board-area keyword
 * below can never narrow a shared file. Substring match on the normalised path.
 */
const CROSS_CUTTING = [
  // main process / preload / e2e harness / smoke seams (also cross-OS surface)
  'src/main/',
  'src/preload/',
  // S4 diagram render-worker assets (vendored Mermaid + worker HTML/bridge) — loaded by a MAIN
  // BrowserWindow, so a change here is a cross-OS render surface (the worker must paint on both
  // Win + the Linux container). Self-documents what already falls open to FULL via the unknown path.
  'resources/diagram-worker/',
  'src/renderer/src/smoke/',
  'e2e/',
  // the shared canvas shell + node/edge plumbing every board renders through
  'src/renderer/src/canvas/canvas.tsx',
  'src/renderer/src/canvas/boardframe',
  'src/renderer/src/canvas/boardnode',
  'src/renderer/src/canvas/errorboundary',
  'src/renderer/src/canvas/boardactions',
  'src/renderer/src/canvas/boardnodes',
  'src/renderer/src/canvas/hooks/usecanvaskeybindings',
  // app root / global styles
  'src/renderer/src/app.tsx',
  'src/renderer/src/main.tsx',
  'src/renderer/src/index.css',
  'src/renderer/src/env.d',
  // store core + schema + cross-board geometry
  'src/renderer/src/store/canvasstore',
  'src/renderer/src/store/slices/',
  'src/renderer/src/store/history',
  'src/renderer/src/store/persistence',
  'src/renderer/src/store/disposeliveresources',
  'src/renderer/src/store/usemcp',
  'src/renderer/src/lib/boardschema',
  'src/renderer/src/lib/boardgeometry',
  'src/renderer/src/lib/nodechanges',
  // build / test / CI / hook config (the e2e selection spoilers)
  'scripts/',
  '.github/',
  '.githooks/',
  'package.json',
  'pnpm-lock.yaml',
  'playwright.config',
  'electron.vite.config',
  'electron-builder',
  'tsconfig',
  'eslint.config',
  'vitest.config',
  'dockerfile',
  '.dockerignore',
  '.npmrc'
]

/**
 * Board-type area keywords (substring match on the normalised, lower-cased path).
 * Applied only AFTER the cross-cutting check, so they only ever see renderer
 * area files. A path may match more than one area (e.g. terminalPreview, a
 * recap modal) — every matched area is unioned in.
 */
const AREAS = {
  terminal: [
    'boards/terminal',
    'terminalboard',
    'terminalstate',
    'terminalpreview',
    'useterminalflip',
    'terminalruntimestore',
    'recapview',
    'recapconsent',
    'recap' // RecapConsentModal / RecapView / recap-* helpers
  ],
  preview: [
    'browser',
    'preview',
    'fullview',
    'localserver',
    'viewportcycle',
    'resolveconnect',
    'portdetect'
  ],
  planning: ['planning', 'freehand', 'lib/pen', 'useplanningpointer'],
  chrome: [
    'appchrome',
    'settingsmodal',
    'welcomescreen',
    'toast',
    'menu',
    'modal',
    'group',
    'palette',
    'wayfinding',
    'minimap',
    'backdrop',
    'emptystate',
    'useboardkeyboardnav'
  ],
  // MCP/orchestration surfaces (consent + sync + swarm-layer UI) — matched BEFORE the bare
  // 'modal' keyword in `chrome` could otherwise be relied on to catch these; the two areas
  // union together so a change confined to e.g. OrchestrationConsentModal.tsx still pulls in
  // the @mcp-tagged consent-flow specs instead of silently landing in @chrome alone.
  mcp: ['orchestration'],
  // Voice dictation (V1+): the renderer capture pipeline + its ephemeral store (and, from
  // V3, the pill/flyout UI — 'voice' catches VoicePill/VoiceFlyout paths too). The MAIN
  // half (voiceIpc) is already FULL via src/main/.
  voice: ['voice'],
  core: ['useboardplacement', 'lib/placement']
}

const TAG_ORDER = ['core', 'terminal', 'preview', 'planning', 'chrome', 'mcp', 'voice']

function normalise(p) {
  return String(p).trim().replace(/\\/g, '/')
}

/** Returns the set of areas a single path belongs to, or `null` for FULL. */
function areasForPath(rawPath) {
  const p = normalise(rawPath)
  if (p === '') return new Set() // blank line — contributes nothing
  if (IGNORE.some((re) => re.test(p))) return new Set() // non-runtime — contributes nothing
  const lp = p.toLowerCase()
  if (CROSS_CUTTING.some((frag) => lp.includes(frag))) return null // -> FULL
  const found = new Set()
  for (const [area, keys] of Object.entries(AREAS)) {
    if (keys.some((k) => lp.includes(k))) found.add(area)
  }
  if (found.size === 0) return null // unknown renderer path -> FULL (fail open)
  return found
}

/**
 * Pure mapping: changed paths -> 'FULL' | '@core|@area|...'.
 * @param {string[]} paths
 * @returns {string}
 */
export function scopeForPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return 'FULL'
  const areas = new Set()
  let sawRuntimePath = false
  for (const path of paths) {
    const result = areasForPath(path)
    if (result === null) return 'FULL'
    if (result.size > 0) {
      sawRuntimePath = true
      for (const a of result) areas.add(a)
    }
  }
  // Only doc/asset/blank paths (or nothing) -> nothing scopable -> FULL.
  if (!sawRuntimePath) return 'FULL'
  areas.add('core') // @core is part of every scoped run
  const tags = TAG_ORDER.filter((t) => areas.has(t)).map((t) => `@${t}`)
  return tags.join('|')
}

// CLI: read a newline-separated path list on stdin, print the verdict.
const invokedDirectly =
  process.argv[1] && normalise(process.argv[1]).endsWith('scripts/e2e-scope.mjs')
if (invokedDirectly) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    input += chunk
  })
  process.stdin.on('end', () => {
    const paths = input
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    process.stdout.write(scopeForPaths(paths) + '\n')
  })
}
