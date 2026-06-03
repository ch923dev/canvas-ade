# Handoff — M-digest T-D2: slide-in digest panel (2026-06-03)

**Branch:** `feat/context-d2-panel` → squash-merged into `feat/context`.
**Plan:** `docs/superpowers/plans/2026-06-03-context-d2-digest-panel.md`.
**Spec:** `docs/superpowers/specs/2026-06-03-desktop-context-memory-design.md` §5.4.

## What landed

The user-visible half of M-digest: an auto slide-in side panel that, on project open, lists one Tier-1
digest card per board — no LLM, no key.

- `src/renderer/src/canvas/DigestPanel.tsx` — presentational panel. Props
  `{ digest: CanvasDigest, open, onOpen, onClose }`. Renders a header line + one card per board
  (type tag · title · status · digest lines), a ✕ dismiss, and a vertical "Context" reopen tab when
  closed. Pure (no LLM/network import).
- `src/renderer/src/canvas/DigestPanel.test.tsx` — 5 unit tests (cards/header/lines, open vs closed +
  reopen, onOpen/onClose, empty canvas), all through real `buildDigest`.
- `src/renderer/src/canvas/Canvas.tsx` — container wiring: `digestOpen` state; **auto-opens once per
  project open/switch** via the render-phase "adjust-state-when-a-key-changes" pattern (keyed on
  `project.dir`; NO setState-in-effect); `digest = useMemo(buildDigest({schemaVersion, viewport,
  boards}), [boards, viewport])`; `<DigestPanel>` rendered beside `<AppChrome>`; `setDigestOpen` added
  to the `installE2EHooks` host.
- `src/renderer/src/index.css` — `.digest-*` block using existing tokens; `prefers-reduced-motion`
  kills the slide transition.
- e2e: `src/renderer/src/smoke/e2eHooks.ts` gains `setDigestOpen` (host) + `openDigest`/`closeDigest`
  (api); `src/main/e2e/probes/context.ts` (`context-digest`) seeds terminal+browser+planning, opens the
  panel, asserts panel-open + cards===boards + a card shows the terminal's launchCommand; registered in
  the playlist in `src/main/e2e/index.ts`.

### Prop contract + test hooks (what later tasks build on)
```ts
interface DigestPanelProps { digest: CanvasDigest; open: boolean; onOpen: () => void; onClose: () => void }
```
`data-test` ids: `digest-panel` (with `data-open`), `digest-card`, `digest-close`, `digest-reopen`.

## Test evidence

- Unit: 5/5 `DigestPanel.test.tsx`. Full gate (worktree): `typecheck && lint && format:check && test`
  → green, **518 unit** (513 + 5).
- e2e (`CANVAS_SMOKE=e2e`, Electron): `context-digest` → **`open=true cards=7 boards=7 cmd=true`**.
  A clean run exited 0 (all probes incl. the browser trio passed). One earlier run showed the known
  browser/browser-gesture/focus-detach env `capturePage` flake (memory `e2e-browser-trio-flake`) —
  not a regression (T-D2 touches nothing in the preview path); cleared on rerun.

## Review

- **Spec compliance:** ✅ (independent code read).
- **Code quality:** Approved-with-minor. The headline UX concern — "does the auto-open re-fire when the
  user edits a board after closing the panel?" — was verified **NO**: `project.status` stays `'open'`
  for the project lifetime, so the open trigger fires once per open/switch (correct). Two non-gating
  follow-up nits (below). The initial wiring tripped a `react-hooks/set-state-in-effect` lint error +
  a `boards` useMemo-dep warning; both fixed in `1e06ead` by moving to the effect-free render-phase
  pattern and computing the digest from `boards`/`viewport` directly.

## Follow-ups (non-gating)

- **a11y:** the closed panel slides off-screen via `translateX(-100%)` but its buttons stay in the tab
  order. Add `inert` to the `<aside>` when `!open` on a future a11y pass. (Acceptable for the
  single-user desktop target now.)
- **consistency:** `DigestPanel` uses `data-open={boolean}` (serializes to `"true"`/`"false"`) whereas
  `FullViewModal` uses the presence pattern `data-open={open ? '' : undefined}`. Functionally
  equivalent; standardize on a future pass.
- **T-M4** will swap the Tier-1 `lines` for cached Tier-2 prose when memory exists (M-memory).

## Status / next

- **M-digest is COMPLETE** (T-D1 pure digest + T-D2 panel) — a working no-key reopen digest.
- **Next:** either open the **M-digest milestone PR** `feat/context` → `main`, or start **M-brain T-B1**
  (provider-agnostic LLM adapter). See `docs/roadmap-context.md`.
