# Unconfirmed candidates (no material measured impact)

27 candidates were surfaced in discovery but **killed by adversarial verification** — the verifier
independently reproduced the measurement and found it does not matter at the real-input workload.
Recorded so they are not re-hunted. (The 1 "shipped by design" item — `osr-dirtyrect-disabled-at-
supersample` — is in `skipped-roadmap.md`.)

Common refutation classes: **cold/low-frequency path** (not a hot loop), **sub-frame-budget**
(<<16.7 ms), **bounded young-gen garbage** (GC'd, not a leak), **opt-in/gated** (default-off), and
**unminified-build artifact** (the byte claim is whitespace, dissolved by `--minify`).

## Main process · persistence · context

| Candidate | File | Why refuted (reproduced) |
|---|---|---|
| `ft-recap-get-full-readproject` | `main/index.ts` | `recap:get` fires **once per flip**, not a loop; full-canvas reparse is cold-path. |
| `ft-pty-onData-per-chunk-postmessage` | `main/pty.ts` | Per-chunk postMessage clone = ~1.2–2.9 µs (sub-KB); uncoalesced but immaterial. |
| `ft-extract-compute-full-split` | `main/agentTranscript.ts` | Fires from one mount `useEffect`, no polling; only when recap back-face shown. |
| `ft-redact-secrets-7pass` | `main/summaryLoop.ts` | Real input is 12 milestones ×<600 chars; the redundant double-redaction costs **71 µs**. |
| `mip-bak-sync-write-per-save` | `main/projectStore.ts` | Real (~3.3–4.1 ms sync `.bak` fsync) but once per ~1 s debounced save — below noise floor. |
| `mip-pretty-json-payload` | `boardSchema.ts` / `projectStore.ts` | 2.5× size real, but +0.8 ms serialize once/save; removing it hurts git-diff readability. |
| `mip-summaryloop-double-read` | `main/summaryLoop.ts` | Opt-in, LLM-key-gated (default off → bails immediately). |
| `mip-gcassets-copy-unlink-per-open` | `main/projectStore.ts` | Once per project-open, alongside far heavier open work; not a hot path. |
| `mip-ipc-structuredclone-save` | `useAutosave.ts` / `projectIpc.ts` | 1 s debounce + single-flight latch coalesces; unavoidable copy, infrequent. |

## OSR / preview (beyond the kept frame-pipeline slices)

| Candidate | File | Why refuted (reproduced) |
|---|---|---|
| `osr-network-inspector-eager-bundle` | `BrowserBoard.tsx` | `BrowserBoard` is already `React.lazy` — inspector code is **not** on cold-start path. |
| `osr-imagedata-alloc-per-frame` | `useOffscreenPreview.ts` | `toBitmap` always returns a `Buffer` (already `Uint8Array`); wrapper alloc trivial. The real cost is the swizzle — kept as SLICE-006. |

## Command Board · Ctrl+K palette

| Candidate | File | Why refuted (reproduced) |
|---|---|---|
| `cb-taskcard-not-memoized` | `command/TaskCard.tsx` | 288–960 card renders are spread across a multi-minute orchestration, not a frame budget. |
| `cb-palette-eager-bundle` | `Canvas.tsx` | Palette = 5.1 KB gzip (~1.7% of eager chunk), ~0.85 ms parse — trivial. |
| `cb-palette-perkeystroke-double-render` | `palette/CommandPalette.tsx` | Filter scoring 0.03 ms/keystroke; `flat.indexOf` 22 ns on hover — not a hot path. |
| `cb-commandstore-tasks-unbounded` | `store/commandStore.ts` | ~19 MB only after a multi-hour session; passive retention, no per-event cost. |

## Planning / whiteboard

| Candidate | File | Why refuted (reproduced) |
|---|---|---|
| `plan-erase-full-scan-per-frame` | `planning/usePlanningPointer.ts` | ~0.18–0.25 ms/frame = ~1.5% of the 60 fps budget; would need ~90× to drop a frame. |
| `plan-pushboardpoint-spread-growth` | `lib/pen.ts` | Spread copy ~3.9 µs worst frame (~2% of draft work); dominated by SLICE-011's `getStroke`. |

## Canvas store / camera

| Candidate | File | Why refuted (reproduced) |
|---|---|---|
| `cs-multiboard-drag-unbatched-sets` | `Canvas.tsx` | Structurally real (K set() calls/frame) but per-frame cost stays within budget at realistic K. |
| `cs-digest-memo-recompute-per-drag-frame` | `Canvas.tsx` | 28.6 µs/frame = 0.17% of budget; ~1.7 ms/s transient only during drag. |
| `cs-autosave-subscriber-per-camera-frame` | `useAutosave.ts` | `hasSavableChange` + debounce-rearm per pan frame, but the work is a cheap guard; debounce absorbs it. |
| `cs-digest-terminal-quadratic-consumer-scan` | `lib/digest.ts` | O(terminals×boards)=1200 visits/call real, but each visit is a field read; magnitude tiny. |

## Bundle / cold-start / backdrop

| Candidate | File | Why refuted (reproduced) |
|---|---|---|
| `ft-langs-barrel-eager-eval-blocking` | `fileBoardSyntax.ts` | The ~210 ms is **source** node_modules ESM resolution; built-chunk eval is ~3–4 ms (tables are lazy closures). Bytes are the real issue → SLICE-001, not eval time. |
| `ft-arborist-dnd-eager-coldstart` | `AppChrome.tsx` | Same lib trio as SLICE-013 but the byte axis is modest; the tighter measurement is captured by `cs-filetree-arborist-eager-in-index` → SLICE-013. |
| `bd-blossom-static-layers-per-frame` | `backdrop/scenes/blossomRiver.ts` | JS op-count real (~1,377 ops) but ~3.7 µs; no rasterization-ms evidence; backdrop is one layer. |
| `bd-starfield-radial-gradient-per-frame` | `backdrop/scenes/starfieldNebula.ts` | Heap flat over ~167 min equiv; 480 gradients/s are bounded young-gen garbage, not a leak. |
| `cs-index-chunk-unsplit-eager` | `main.tsx` | The 1.36 MB is **unminified**; `--minify` halves it to 719 KB. Headline byte figure is a build-config artifact, not a chunking problem. (Enable minification — orthogonal, not a slice here.) |
| `bd-raf-reschedule-highrefresh` | `backdrop/scenes/blossomRiver.ts` | ~0.01 ms/s JS, 0 allocs/wakeup; backdrop is a single layer (max 1, not N). |

> **Note on the unminified build:** several byte-based claims (`cs-index-chunk-unsplit-eager`,
> `cb-palette-eager-bundle`) dissolve under minification. The standing recommendation is to verify
> the renderer build minifies for production (`electron-vite build` should; confirm `minify` is on).
> That is a one-line config check, **not** a slice — and it does **not** rescue SLICE-001/013, whose
> wins are *unreachable code removed* (gzip-measured), independent of minification.
