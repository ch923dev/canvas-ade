# Canvas ADE — Deep Review + Electron→Flutter Migration Assessment

**Date:** 2026-06-14 · **Method:** 20-agent dynamic workflow (10 subsystem maps · 2 rendering
forensics · 7 research-backed Flutter feasibility studies · 1 synthesis) · ~1.6M tokens.
**Motivation given:** migrate Electron→Flutter to fix "the rendering issue."

> **Bottom line (go/no-go): NO-GO on a full Electron→Flutter migration as a remedy for the two
> rendering issues.** Terminal blur is *already fixed* in the current build; browser-preview
> occlusion is *not automatically fixed* by Flutter (most desktop webviews reproduce it) and the
> *same* fix is available in Electron today at a fraction of the cost. Run the 1–2 week
> **Electron offscreen/CDP-screencast spike** first — it settles the entire question cheaply.

---

## 1. What the app is (review snapshot)

~72k LOC TS/TSX, 389 files, 414 commits, ~2,200 vitest+Playwright tests. A mature, deeply
Electron/Chromium/Node-coupled desktop app: an infinite zoomable canvas (React Flow v12) whose
nodes are live **Terminal** (node-pty⇄xterm), **Browser** (native `WebContentsView` preview),
and **Planning/Whiteboard** boards, plus an MCP swarm layer, an LLM/context subsystem, and a
hardened renderer/main security split.

### Subsystem difficulty matrix (Flutter portability)

| Subsystem | ~LOC | Complexity | Flutter difficulty | Note |
|---|---:|---|---|---|
| process-security | 780 | high | **very-hard** | model is built on Chromium primitives with no Flutter analog |
| terminal (pty+xterm+blur machinery) | 3,189 | high | **very-hard** | UI swap easy; lifecycle (park/adopt/reap/tree-kill) is the cost |
| browser-preview-rendering | 3,588 | very-high | **very-hard** | THE rendering issue; rests on immature Flutter webview |
| canvas-engine (React Flow) | 4,094 | very-high | **very-hard** | no React Flow analog; not independently portable |
| whiteboard-planning | 5,750 | high | hard | Flutter's *strongest* fit (canvas-native) |
| persistence-schema | 2,928 | high | hard | cleanest port; security model *simplifies* |
| mcp-orchestration | 1,551 | very-high | **very-hard** | TS/Node SDK; keep as sidecar |
| llm-context | 1,400 | high | **very-hard** | Node logic; keep as sidecar |
| state-store (Zustand) | 2,903 | high | hard | → Riverpod/Bloc/signals |
| build-test-infra | 750 | high | hard | packaging ports; **e2e + auto-update regress** |

### Security model (the load-bearing invariants — must never weaken)

`contextIsolation:true` · `sandbox:true` · `nodeIntegration:false` · `webviewTag:false`; every
privileged `ipcMain.handle` is frame-guarded by `isForeignSender` (a Browser board sharing the
IPC bus is denied); the PTY data plane rides a transferred `MessagePort` (raw I/O never touches
the IPC bus); MCP PTY writes pass a CSPRNG single-use nonce + human-confirm + append-only audit;
CSP prod policy drops `unsafe-inline`. **Key finding:** most of this apparatus exists *solely* to
defend against an untrusted Chromium renderer hosting our own UI — in single-process Flutter that
renderer does not exist, so those invariants **disappear** rather than needing a port. The catch:
they **return** the instant a webview is embedded (browser-preview).

---

## 2. The two rendering issues — forensics

### Issue A — Browser-preview occlusion *(the only hard rendering problem)*

**Mechanism.** Each Browser board is a real `WebContentsView` (`src/main/preview.ts:328`) inserted
into the host window's native view tree (`preview.ts:508`). A `WebContentsView` is a **separate
native OS/Chromium compositor surface**, composited *above* the entire HTML layer with no z-index,
clip, border-radius, or transform relationship to the DOM. It therefore (a) paints over every board
and chrome element it overlaps (digest panel, dock, camera cluster, toasts, menus, modal scrim) and
(b) can only be an axis-aligned, unrounded rectangle. ADR 0002 records this as an inherent, accepted
constraint.

**Current mitigation** (`workable-but-fragile`): detach + HTML-snapshot (`capturePage` → clippable
`<img class="bb-snapshot">`) during motion/LOD, plus a hand-maintained registry of "exclusion zones"
(`previewPlan.ts`) that demote a live view to its snapshot whenever it overlaps chrome.

**Fixable in Electron? YES** (effort: large, confidence: medium). Render the page **offscreen** and
paint its frames into an HTML `<canvas>` — the preview becomes an ordinary clippable / rounded /
z-orderable / transformable DOM element and the native overlay *disappears*. Two concrete paths:
1. **Offscreen `WebContents`** (`webPreferences.offscreen:true`) → consume the `'paint'` event
   (NativeImage per dirty rect, `setFrameRate` cap) → stream to a renderer `<canvas>`.
2. **CDP `Page.startScreencast`** → consume `screencastFrame` → draw into `<canvas>`. **ADR 0002
   explicitly pre-authorized this** ("Build as real WebContentsView so CDP attach can be added
   later").

The snapshot-into-HTML half is **already built** (`capturePreview → bb-snapshot`), so this is
essentially upgrading a frozen single-shot snapshot into a live frame stream and deleting the
native-attach + exclusion-zone machinery. The two hard parts: (1) input no longer arrives for free —
every click/scroll/keypress must be hit-tested and forwarded via `webContents.sendInputEvent`;
(2) OSR/screencast paints through GPU readback, costing more CPU/GPU than today's proven
165fps/6.1ms native path — must validate throughput.

**Does Flutter fix it? `depends-on-approach`.** Flutter renders its own UI to one Skia/Impeller
surface, but the webview is a foreign embed and the **embedding strategy decides everything**:
- **Native-child-window plugins** (`flutter_inappwebview` desktop, `webview_windows` native-HWND
  path, `desktop_webview_window`) hand the OS a child window that composites **above** Flutter —
  **identical occlusion bug**, and arguably *worse* because Flutter has none of the detach+snapshot
  mitigation already built here.
- **Offscreen→Texture** (`webview_cef`, or `webview_windows` offscreen mode) makes the page a GPU
  **texture inside Flutter's scene graph** — clippable, transformable, z-orderable. **This is the
  only path that fixes occlusion**, and it is the *exact same architectural choice* (offscreen →
  composite-as-our-own-surface, manual input forwarding, paint-throughput cost) available in
  Electron today via OSR/CDP.

**The catch (showstopper-class):** as of June 2026 there is **no actively-maintained, cross-platform
(Win+mac+Linux), texture-based webview** in the Flutter ecosystem. `webview_windows` (texture-capable)
is Windows-only and dormant ~2 years; `webview_cef` (cross-desktop) is a single-maintainer WIP with
no 2025–2026 release and "APIs not stable." The official `webview_flutter` has **no desktop support**.
So the migration's headline rendering benefit rests on the **weakest dependency in the entire plan** —
one you would have to vendor/fork and own (including ~150–200 MB CEF binary packaging + multi-process
crash isolation).

### Issue B — Terminal font blur *(already fixed)*

**Mechanism.** `@xterm/addon-webgl` sizes its canvas backing store from `window.devicePixelRatio`
alone (`WebglRenderer.ts:88`), with no awareness of the page's CSS transform. React Flow applies
`translate/scale(z)` to the viewport; at z≠1 the Chromium compositor **bilinear-resamples the
already-rasterized bitmap** → structural blur. Chromium's at-rest re-rasterization rescues DOM/SVG
but can never re-raster a `<canvas>`.

**Status: FIXED in Electron** (mitigation: `workable-but-fragile`→effective; confidence: high). The
shipped FREEZE counter-scale (`useTerminalReraster` + `settledZoomStore`) lays the xterm host out at
`content × cs` with `transform: scale(1/cs)` so the GL backing store maps **1:1 to device pixels at
every settled zoom**; a single unclamped font seam (`effectiveTerminalFont`) carries the fractional
scale, written only to `term.options` (never to the store/undo). Blur classes #1 (bitmap resample)
and #2 (defeated hinting) are eliminated at rest; only during-gesture softness and physically-small
text remain (intentional).

**Does Flutter fix it? `flutter-fixes-it` — structurally.** `xterm.dart` paints each cell as
**vector text** (`canvas.drawParagraph` + an LRU `ParagraphCache`), no fixed-dpr bitmap atlas. Skia
re-rasterizes glyphs at the final transformed resolution, so the counter-scale gymnastics, the
WebGL-budget dance, the no-clip rAF loop, and the snap band all become **unnecessary**. *But:* this
fixes a bug that is **already fixed here** — migrating to gain it is not a reason to migrate. (Caveat:
only holds while live-composited; snapshotting the terminal to a raster reintroduces the blur.)

---

## 3. Why a full migration is the wrong tool for this job

1. **Terminal blur is already fixed in both stacks** — no net gain.
2. **Occlusion is the only hard problem, and Flutter doesn't auto-fix it** — it reproduces it on
   maintained webviews and fixes it only via the immature `webview_cef`/`webview_windows` texture
   path you'd have to own.
3. **The same occlusion fix exists in Electron today** (OSR/CDP → HTML canvas), reusing already-built
   snapshot machinery, at **~1–2 months** vs **18–24 engineer-months**.
4. **The ~22k-LOC Node/TS backend** (MCP, LLM, summaryLoop, memoryEngine, recap, audit, node-pty) and
   **its ~12k LOC of tests do not port to Dart.** Best case keeps it as a bundled **Node sidecar** —
   preserving the logic but shipping **two runtimes** (Dart binary + ~60–90 MB Node) per platform,
   doubling packaging/signing/auto-update surface — on top of the already-unsolved Phase 5 release
   blocker.
5. **The e2e gate gets materially weaker.** Flutter `integration_test` can't touch native
   views/webviews; `patrol`'s native automation is Android/iOS/macOS only — **no Windows or Linux
   desktop native automation exists.** The Playwright `_electron` harness (MAIN `evaluate`,
   `capturePage` native-view PNG asserts, real-OS `sendInputEvent`) — the exact harness that caught
   and verified-fixed the occlusion/camera-sync bugs (PR #82 class) — **has no equivalent on the
   platforms this app ships on.**
6. **Auto-update regresses.** `electron-updater` covers Win/mac/Linux (incl. AppImage/zsync) today;
   the Flutter analogue `auto_updater` is Win+macOS only (Linux unsupported) → two update systems.
7. **The migration is not separable.** React Flow holds *live content* (terminal, browser,
   whiteboard); moving "the canvas engine" forces moving every board's content — i.e. a full-app
   rewrite, not a swappable layer.

**Realistic effort:** full migration **12–30 engineer-months (realistically 18–24)**. Fix-in-Electron:
occlusion ~1–2 months; terminal blur already shipped.

---

## 4. Recommendation

**FIX-IN-ELECTRON, not migrate.**

- **Terminal blur:** ship nothing new — it's fixed (residual edge-hardening only).
- **Occlusion:** build the offscreen-render-to-HTML-canvas path inside Electron (OSR `'paint'` or CDP
  `Page.startScreencast`). Gate it behind the spike below.
- **Reinvest the saved 18–24 engineer-months** into **Phase 5 (packaging/signing)** — the genuine
  release blocker.

**Do NOT use Tauri for this** — its OS-native webview (WKWebView/WebView2/WebKitGTK) reproduces the
same overlay/occlusion constraint and adds no fix; only relevant for a separate bundle-size goal.

### Phase 0 — the one experiment that settles it (1–2 weeks, Electron)

Render **one** Browser board offscreen and paint its frames into an HTML `<canvas>`:
- Spike CDP `Page.startScreencast` (or offscreen `WebContents` `'paint'`) → stream over the existing
  preview IPC → draw into a `<canvas>` z-ordered/clipped/rounded by normal CSS.
- Forward one click + scroll + keypress via `webContents.sendInputEvent`.
- Measure FPS/CPU vs the current native path; validate `setZoomFactor` responsive reflow + DPR-under-
  camera-zoom sharpness.

**Outcome:** if it holds (high likelihood — the snapshot half is already built and ADR 0002
pre-authorized CDP), occlusion is fixed in Electron and the migration motivation collapses. If it
fails on throughput/input fidelity, *only then* does a Flutter rewrite earn consideration.

---

## 5. If you migrate anyway — the gated de-risking plan

Reconsider Flutter **only** as a deliberate whole-app strategic bet, and only if **(a)** the Electron
spike fails **and (b)** a `webview_cef` cross-OS spike succeeds **and (c)** you accept owning a forked
CEF plugin + a weaker e2e gate. Then sequence so the program can be killed cheaply before the bulk
cost:

| Phase | Goal | De-risks |
|---|---|---|
| **0 (1–2 wk)** | Electron offscreen/CDP spike (above) | the actual question — can occlusion be fixed without a rewrite |
| **1 (1–2 wk)** | `webview_cef` spike: 4 live texture boards in a Transform/ClipRRect canvas; per-view zoom + 390/834/1280 reflow; `RepaintBoundary` capture; crash a board — **on all 3 OSes** | the immature webview dependency the whole payoff rests on |
| **2 (3–6 wk)** | Persistence/security pilot: `projectStore` atomic-write + schema migrate + `flutter_secure_storage`, tests ported first | toolchain + atomic-write correctness on the cleanest subsystem |
| **3 (2–3 mo)** | Backend-as-sidecar + terminal: bundle the Node backend, talk over the existing loopback MCP HTTP + a socket for the PTY byte stream; `xterm.dart` + tree-kill | the two-runtime ship + PTY data-plane re-plumb (hardest non-rendering piece) |
| **4 (3–6 mo)** | Canvas shell + whiteboard + full test/packaging/update rebuild | sequenced LAST — lowest leverage, highest cost; killable before sunk |

**Non-negotiable carry-overs if you migrate:** keep the entire Node backend as a **sidecar** (do NOT
port to Dart; do NOT attempt `pkg`/Node-SEA single-binary — both are dead ends for node-pty); keep
PTY input trusted-user-only and off any Browser-derived path; keep the MCP write nonce+confirm+audit
gate; mind macOS App Sandbox child-process entitlements (may force notarized direct-download over Mac
App Store).

---

## Appendix — full structured evidence

The complete 20-agent output (per-subsystem maps, both forensics objects, all 7 Flutter feasibility
studies with package-maturity research, and the synthesis) is the workflow result for run
`wf_b3986fae-d26`. Key package-maturity findings: `xterm.dart`/`flutter_pty` (usable/immature,
TerminalStudio, low velocity — vendor); `webview_cef` (immature, single-maintainer, no 2025–26
release); `webview_windows` (usable but Windows-only, dormant); `flutter_secure_storage`/`path_provider`
(production); `vyuh_node_flow` (usable, pre-1.0, single-publisher); `perfect_freehand` Dart port
(production); `auto_updater` (Win+mac only, no Linux); `patrol` (no desktop Win/Linux automation).
</content>
</invoke>
