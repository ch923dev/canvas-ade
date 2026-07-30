// e2e scope selector (dx-audit MT-1 / PR-3; re-scoped 2026-07-28, "push cheap / merge full").
//
// Maps a list of changed file paths -> one of:
//   * `NONE` — nothing that can change the app under test; the caller SKIPS e2e,
//   * `FULL` — run every spec,
//   * a Playwright `--grep` expression (a scoped subset of the e2e suite).
// The pre-push hook pipes its computed change-set to this script on stdin and uses
// the verdict to scope the Windows e2e leg; `scopeForPaths` is also unit-tested
// directly (it is a pure function of a path list).
//
// SAFETY CONTRACT — fail OPEN to FULL, never to a narrower set:
//   * any cross-cutting path (src/preload, the e2e harness, the shared canvas
//     shell, the store/schema, the MAIN entrypoint/lifecycle) -> FULL,
//   * any path that matches no known area -> FULL,
//   * an empty / unparseable input -> FULL.
// `NONE` is emitted ONLY for paths that provably cannot reach the running app —
// docs, images, vitest `*.test.ts`/fixtures, build/release/eval tooling, CI
// workflow files. Those are covered by the pre-commit trio + the Actions `check`
// job; running Electron for them buys nothing.
//
// WHY MAIN-PROCESS PATHS CAN NOW SCOPE (2026-07-28). `src/main/**` used to route
// blanket-FULL because it is the cross-OS surface. That is now handled on the OTHER
// axis instead: the pre-push hook NEVER runs the Linux leg (it is paid once per PR
// at the pre-merge gate, `pnpm test:e2e:matrix`). Given the Linux leg is deferred
// either way, blanket-FULL on the Windows leg bought spec breadth, not OS coverage
// — so the well-partitioned MAIN prefixes (pty/preview/voice/mcp/swarm) scope by
// area like the renderer, and only the shared MAIN core stays FULL.
//
// The tags mirror the e2e spec describe-title tags:
//   @core  @terminal  @preview  @planning  @chrome  @mcp  @voice
// `@core` is ALWAYS included in a scoped grep (boot / placement / recovery /
// isolation specs guard behaviour any change can perturb).

/**
 * Non-runtime paths that provably never affect the app under test -> they
 * contribute nothing, and a change-set made only of these yields `NONE`.
 */
const IGNORE = [
  // docs + media
  /^docs\//,
  /\.md$/i,
  /\.(png|jpe?g|gif|webp|webm|mp4|svg|ico)$/i,
  // vitest unit/integration specs + their fixtures — the pre-commit/CI `check`
  // job owns these; they are never bundled into the app the e2e harness launches.
  // (`e2e/**` specs are NOT matched here — they end in `.e2e.ts`, and the hook
  // targets touched e2e spec FILES directly.)
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)__(fixtures|mocks|snapshots)__\//,
  // CI/automation config — changes how CI runs, not how the app behaves.
  /^\.github\//,
  // Lint / format / vitest config: these govern the pre-commit trio and the unit
  // suites. None of them is read by `electron-vite build` or by the running app, so
  // they cannot change what the e2e harness observes. (`tsconfig*` deliberately
  // stays cross-cutting — it DOES feed the bundle's module resolution.)
  /^eslint\.config\./,
  /^vitest\.config\./,
  /^\.prettier(rc|ignore)/,
  /^\.editorconfig$/,
  /^\.gitattributes$/,
  /^\.gitignore$/,
  // The bench suite is a SEPARATE Playwright config (playwright.bench.config.ts,
  // testMatch '**/*.bench.ts'); the gate config matches '**/*.e2e.ts' only, so a
  // bench file can never run in the gate. `benchSink.ts` is imported by bench
  // specs exclusively (verified: no *.e2e.ts references it).
  /^e2e\/.*\.bench\.ts$/,
  /^e2e\/benchSink\.ts$/,
  // build / release / benchmark / eval tooling that never ships into the app.
  // NB: scripts/e2e-scope.mjs + the voice asset generators are deliberately NOT
  // here (see CROSS_CUTTING / AREAS.voice below).
  /^scripts\/(release|gen-icon-mac|gen-icon-win|gen-updates-json|serve-local-feed|sca-audit|bench-baseline|tts-spike|status-palette-gate)/,
  /^scripts\/stt-eval\//,
  // non-app trees
  /^marketing\//,
  /^design-reference\//,
  /^release\//,
  /^supabase\//,
  /^\.impeccable\//,
  /^\.claude\//,
  /^\.agents\//,
  /^\.codegraph\//
]

/**
 * MAIN-process + preload area prefixes. Checked BEFORE the cross-cutting list so the
 * well-partitioned native subsystems scope like renderer areas; everything else under
 * `src/main/` or `src/preload/` falls through to those blanket cross-cutting entries
 * -> FULL. Substring match on the normalised, lower-cased path.
 *
 * Both trees are per-domain by file name (`pty*`, `previewOsr*`, `voice*`, `mcp*`,
 * `swarm*` in MAIN; `terminalApi.ts`, `voice.ts`, `mcpApi.ts`, `swarm.ts` in preload),
 * so a domain file is as scopable as its renderer counterpart. The SHARED pieces —
 * `src/main/index.ts` + lifecycle/window/security/project/auth/llm/jarvis/git plumbing,
 * and `src/preload/index.ts`/`index.d.ts` + the cross-domain APIs — stay FULL.
 */
const NATIVE_AREAS = {
  terminal: [
    'src/main/pty',
    'src/main/terminal',
    'src/main/recap',
    'src/main/agentrecap',
    'src/main/agenttranscript',
    'src/main/agentmilestones',
    'src/main/bgbusyprobe',
    'src/main/backgroundsessions',
    'src/preload/terminalapi',
    'src/preload/recapapi'
  ],
  preview: [
    'src/main/previewosr',
    'src/main/previewscreenshot',
    'src/main/previewshared',
    'src/main/localserver',
    'src/main/portdetect'
  ],
  voice: [
    'src/main/voice',
    'src/main/openaispeak',
    'src/main/openaitranscribe',
    'src/main/cloudsttengine',
    'src/main/cloudttsengine',
    'src/main/micpermission',
    'src/preload/voice'
  ],
  mcp: [
    'src/main/mcp',
    'src/main/swarm',
    'src/main/orchestration',
    'src/main/dispatch',
    'src/preload/mcpapi',
    'src/preload/mcpserversapi',
    'src/preload/swarm',
    // Orchestration P4 (observability): the external-worker feed, the blocked→attention
    // classifier, and the end-of-run findings batch. All MAIN-side and confined to the
    // orchestration domain, so they scope with the rest of it rather than failing open.
    'src/main/commandfeed',
    'src/main/findings',
    'src/main/workerattention',
    // shared MAIN⇄renderer type/contract modules for the same domains
    'src/shared/mcptypes',
    'src/shared/commandfeedtypes',
    'src/shared/swarmledgertypes',
    'src/shared/rolepacks'
  ]
}

/**
 * Cross-cutting paths -> FULL. Checked AFTER `MAIN_AREAS` (so a MAIN subsystem can
 * scope) but BEFORE the renderer `AREAS` keywords (so a board-area keyword can never
 * narrow a shared file). Substring match on the normalised, lower-cased path.
 */
const CROSS_CUTTING = [
  // MAIN core (entrypoint, window/security, lifecycle, project/auth/llm/jarvis/git
  // plumbing) + preload + the e2e harness + the smoke seams.
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
  // build / test / hook config (the e2e selection spoilers). `package.json` is
  // cross-cutting for DEPENDENCY/script edits — the pre-push hook strips it from
  // the change-set first when the only edited line is the `version` bump (the
  // CLAUDE.md per-PR bump would otherwise force FULL on literally every push).
  'scripts/e2e-scope',
  '.githooks/',
  'package.json',
  'pnpm-lock.yaml',
  'playwright.config',
  'electron.vite.config',
  'electron-builder',
  'tsconfig', // feeds the bundle's module resolution — unlike eslint/vitest config (IGNOREd)
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
  // 'boards/command' + 'commandstore' are P4: the Command board is the orchestration face the
  // external-worker feed renders on, so a change to it belongs with @mcp rather than @chrome.
  mcp: ['orchestration', 'swarm', 'boards/command', 'commandstore', 'commanddispatch'],
  // Voice dictation (V1+): the renderer capture pipeline + its ephemeral store (and, from
  // V3, the pill/flyout UI — 'voice' catches VoicePill/VoiceFlyout paths too). The generated
  // TTS manifest / filler assets are runtime inputs, so their generators map here too.
  voice: ['voice', 'scripts/gen-tts-manifest', 'scripts/gen-voice-fillers'],
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
  const nativeAreas = new Set()
  for (const [area, keys] of Object.entries(NATIVE_AREAS)) {
    if (keys.some((k) => lp.includes(k))) nativeAreas.add(area)
  }
  if (nativeAreas.size > 0) return nativeAreas // a partitioned MAIN/preload subsystem
  if (CROSS_CUTTING.some((frag) => lp.includes(frag))) return null // -> FULL
  const found = new Set()
  for (const [area, keys] of Object.entries(AREAS)) {
    if (keys.some((k) => lp.includes(k))) found.add(area)
  }
  if (found.size === 0) return null // unknown path -> FULL (fail open)
  return found
}

/**
 * Pure mapping: changed paths -> 'NONE' | 'FULL' | '@core|@area|...'.
 * @param {string[]} paths
 * @returns {string}
 */
export function scopeForPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return 'FULL'
  // An all-blank list carries no information at all — that is "unparseable", not
  // "provably non-runtime", so it must fail OPEN to FULL rather than skip e2e.
  if (!paths.some((p) => normalise(p) !== '')) return 'FULL'
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
  // Every path was provably non-runtime (docs / unit tests / CI / build tooling)
  // -> nothing the e2e harness could observe changed. Skip e2e entirely.
  if (!sawRuntimePath) return 'NONE'
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
