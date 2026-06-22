# Plan — Slice & optimize `index.css` (4.3k lines → feature partials)

**Branch:** `feat/css-slice` · **Date:** 2026-06-23 · **Status:** spec (no impl yet)
**Zone:** `src/renderer/src/index.css`, `src/renderer/src/styles/**`
**Doc lifecycle:** per-slice spec — delete on the merging PR (residue = a `docs/archive/build-history.md` line).

---

## 1. Problem & review findings

`src/renderer/src/index.css` is a **single 4,315-line / ~130 KB** stylesheet — the entire renderer's
visual surface in one file. It is loaded exactly once (`main.tsx:6 → import './index.css'`); there are
no CSS Modules and no other `.css` under `src/`.

**Why it is well-positioned for a safe slice (the leverage):**

1. **Strictly namespaced by feature prefix.** `bb-` (browser, ~217 selectors — the giant), `ca-`
   (canvas chrome + motion, ~93), `bd-`/`backdrop-`, `pl-` (planning), `cp-` (command palette),
   `lib-` (library), `digest-`, `group-`, `welcome-`/`recent-`, `toast-`, `align-`, `wayfinding-`,
   `net-`, `fullview-`, `project-`, `placement-`. Collisions across features are essentially nil.
2. **Cascade-order dependencies are documented and intra-block.** The handful of order-sensitive
   rules (`.bb-url-flash` must follow `.bb-url-invalid`; `.bd-seg-btn` specificity exclusion;
   `.bb-url-field.bb-url-invalid` after `:focus-within`) all live **inside one feature block**. The one
   global, `@media (prefers-reduced-motion)`, uses `transition/animation: none !important` → its
   cascade position is irrelevant.
3. **Verified: every duplicated sole-selector stays within one feature prefix.** A scan for selectors
   that appear 2+ times as a sole selector returns only intra-feature dups (`bb-net-*`, `bb-url-*`,
   `bb-osr-*`, `align-guides`, …). **No selector spans two features.** This is the property that makes
   the slice provably output-preserving (§4).

**Build reality (no runtime cost):** Vite/Rollup inlines CSS `@import` at build time **preserving
source order** and emits a single bundle (`out/renderer/assets/index-*.css`). Splitting into partials
re-aggregated by an `@import` barrel produces **byte-identical output** with **zero** added requests or
runtime change.

**Tooling constraints:**
- No stylelint, no `postcss.config` (postcss is only transitive). **Prettier formats `.css`** (runs on
  `.`), so every new partial must be prettier-clean or `pnpm format:check` fails (the PR #70 lesson).
- Class names are largely **static strings in JSX** (greppable) — relevant to the Phase 2 dead-rule
  audit, but some are constructed dynamically, so that audit stays conservative.

---

## 2. Scope (decided)

- **Phase 1 — Slice (byte-for-byte safe).** Mechanical reorganization into `styles/` partials,
  re-aggregated by an exact-order `@import` barrel. Proven by an **empty emitted-CSS diff**.
- **Phase 2 — Optimize (output-changing, separate PR).** Dead-rule audit + dedupe + a regrowth guard.
  Gated on the visual/e2e suite, *never* bundled with Phase 1.

Granularity: **~22–25 partials in subdirectories** (chosen). `browser.css` and `browser-devtools.css`
stay separate (the devtools inspector alone is ~900 lines).

---

## 3. Target structure

```
src/renderer/src/
  index.css                         ← barrel: ONLY @import lines + section comments, in cascade order
  styles/
    tokens.css                      @font-face · :root tokens · .t-* type helpers      (1–191)
    motion.css                      ca-* anim/transition utils + @keyframes            (193–325)
    base.css                        reduced-motion media · reset · app shell · rf base (574*–761)
    chrome/
      dock.css                      .ca-dock-*                                          (327–369)
      sidepanel.css                 .ca-sidepanel-* · .ca-ftree-* (file tree)           (371–572)
      backdrop.css                  .backdrop-* · .bd-* (picker/gallery/grid)           (763–988)
      controls.css                  focus-ring cluster · ca-t-ctl clusters · modal btns (2644–2721)
      menu.css                      project switcher · Menu shell · inline title edit   (2928–3033)
      tidy.css                      Tidy-layout picker                                  (3034–3068)
      fullview.css                  fullview scrim/frame · "Esc to exit" hint           (3069–3145)
    boards/
      node.css                      smoke node · board node · NodeResizer               (989–1048)
      browser.css                   .bb- chrome: urlbar/stage/frame/states/ime/badges   (1050–1316)
      browser-devtools.css          .bb-net-* · .net-* network inspector (+headers/preview/timing) (1317–2240)
      browser-overlays.css          OS-3 native-widget & dialog overlays · bb-osr-*     (2241–2525)
      planning.css                  .pl-* whiteboard (notes/text/checklist/width handle)(2526–2643)
      text-toolbar.css              .pl-text-toolbar floating typography toolbar         (2722–2769)
      terminal.css                  preview port picker · launch hint · .ca-term-hint   (3146–3268)
    islands/
      toast.css                     .toast-* island                                     (3269–3362)
      minimap.css                   .wayfinding-* minimap island                         (3363–3402)
      command-palette.css           .cp-* command palette                                (3403–3595)
    panels/
      digest.css                    .digest-* reopen-context panel                       (3687–3887)
      library.css                   .lib-* Project Library                               (3888–4052)
    canvas/
      connect-picker.css            multi-select connect picker                          (3596–3648)
      align-guides.css              smart alignment guides · overlap nudge               (3649–3686)
      drag-create.css               .placement-* capture overlay · submit-well           (4053–4096)
      board-groups.css              .group-* named board groups                          (4097–4315)
    screens/
      welcome.css                   welcome / project-picker / loading / recents         (2770–2927)
```

\* `base.css` starts at the reduced-motion `@media` block (574) because it sits immediately before the
reset (611) in source — keeping them together preserves exact byte order.

**The one inviolable rule:** the barrel's `@import` order **reproduces the current top-to-bottom block
order, exactly.** A feature whose blocks are interleaved with another's contributes **multiple**
`@import` lines at their true ordinal slots (e.g. `planning.css` → `controls.css` → `text-toolbar.css`)
rather than being forced contiguous. Partial *cohesion* never overrides *source order*.

### Barrel sketch (`index.css`)

```css
/* Canvas ADE renderer styles — sliced from the former monolith (feat/css-slice).
   ORDER IS LOAD-BEARING: these @imports reproduce the original cascade exactly.
   Do not reorder without re-running the emitted-CSS equivalence check (docs … PLAN.md §4). */
@import './styles/tokens.css';
@import './styles/motion.css';
@import './styles/chrome/dock.css';
@import './styles/chrome/sidepanel.css';
@import './styles/base.css';
@import './styles/chrome/backdrop.css';
@import './styles/boards/node.css';
@import './styles/boards/browser.css';
@import './styles/boards/browser-devtools.css';
@import './styles/boards/browser-overlays.css';
@import './styles/boards/planning.css';
@import './styles/chrome/controls.css';
@import './styles/boards/text-toolbar.css';
@import './styles/screens/welcome.css';
@import './styles/chrome/menu.css';
@import './styles/chrome/tidy.css';
@import './styles/chrome/fullview.css';
@import './styles/boards/terminal.css';
@import './styles/islands/toast.css';
@import './styles/islands/minimap.css';
@import './styles/islands/command-palette.css';
@import './styles/canvas/connect-picker.css';
@import './styles/canvas/align-guides.css';
@import './styles/panels/digest.css';
@import './styles/panels/library.css';
@import './styles/canvas/drag-create.css';
@import './styles/canvas/board-groups.css';
```

`main.tsx` is **unchanged** (still `import './index.css'`).

---

## 4. Verification — the equivalence oracle (keystone)

Because the build emits one concatenated bundle, the emitted CSS is a **near-mathematical proof** of
equivalence.

**Tier 1 — byte-identical bundle (primary, must pass):**
1. On `main` (pre-change): `pnpm build`; copy `out/renderer/assets/index-*.css` → `baseline.css`.
2. After slicing: `pnpm build`; copy the new bundle → `after.css`.
3. `prettier --parser css` both (normalizes only whitespace), then `diff`. **Target: empty.**
4. Any hunk ⇒ a block landed out of source order ⇒ fix that `@import`'s position and rebuild.

Why empty is achievable *and* provable: partial boundaries sit at feature seams, and §1.3 verified no
selector spans two features ⇒ inter-partial order is the *only* thing that could change, and the barrel
pins it to the original sequence.

**Tier 2 — safe-reorder fallback (only if a deliberate regroup is ever chosen):** parse both bundles to
the set of `selector { sorted-declarations }`; assert the sets are equal **and** no selector string
occurs in more than one partial. Equal sets + unique-across-partials ⇒ any reordering is provably
inert. (Not expected to be needed; Tier 1 should hold.)

**Plus the standing gates (CLAUDE.md):**
- `pnpm typecheck && pnpm lint && pnpm format:check` green.
- **Manual dev check** with the mandated stamp: `$env:CANVAS_DEV_TITLE='PR#NNN css-slice'; pnpm dev` —
  confirm the title in alt-tab, eyeball each board type / panel / island.
- **Pre-push e2e** (renderer-scoped → Windows leg auto) + **full matrix at the pre-merge gate**.

---

## 5. Phase 1 execution

One mechanical PR on this worktree:

1. Capture `baseline.css` from a clean `main` build (§4.1).
2. Create `styles/**` by **cut-pasting blocks verbatim** — every WHY-comment travels with its rule; no
   rule text is edited.
3. Replace `index.css`'s body with the ordered `@import` barrel (§3).
4. Rebuild → normalize → **`diff` empty** (Tier 1).
5. `typecheck · lint · format:check` green.
6. Manual dev check + pre-push e2e.
7. PR; full matrix at merge; squash. Append a `build-history.md` line; delete this spec in the same PR.

**Risks & mitigations:**
| Risk | Mitigation |
|---|---|
| A block lands out of cascade order | Caught 100% by the Tier-1 empty-diff. Primary net. |
| Prettier drift on new files | `format:check` in the gate (PR #70 lesson). |
| `@import` resolution quirk in Vite | Fallback: ordered JS imports in `main.tsx` (same output). |
| `@import` must precede other rules | Barrel is *only* `@import`s + comments — satisfied by construction. |

---

## 6. Phase 2 — optimize (separate PR, output-changing)

Not byte-safe ⇒ relies on the visual/e2e gate + manual check, never the diff oracle. Land *after*
Phase 1 is merged so each pass is independently bisectable.

1. **Dead-rule audit (conservative).** For each class token, grep the renderer JS/TSX for the literal
   string. Zero-hit classes are *candidates*, not auto-deletes — confirm a single static origin before
   removing; skip anything that could be built via template literal / `clsx`. Prime suspects:
   `.react-flow__node-smoke` (smoke-harness-only), any `spike`-era refs, orphaned `data-*` states.
2. **Dedupe into utilities.** The `::-webkit-scrollbar` / `scrollbar-width` pattern repeats across
   `.ca-ftree-list`, `.bb-net-list`, `.bb-net-dbody`; the `:focus-visible { box-shadow: 0 0 0 1.5px
   var(--accent) }` accent-ring repeats (vol slider, library controls, …). Fold into
   `styles/util/scrollbars.css` + a `.u-focus-ring` (or `:where()` group). Verify visually.
3. **Regrowth guard (the keystone — mirrors the JS `max-lines` ratchet).** Add
   `scripts/css-budget.mjs`: assert each partial ≤ ~400 lines and that `index.css` contains only
   `@import` + comments. Wire into the cheap pre-commit trio / the CI `check` job so partials can't
   silently re-bloat back toward a monolith.

**Phase 2 risk:** dynamic class names make a grep-only audit blind ⇒ a false "dead" verdict. Keep
removals conservative (single clear static origin); when in doubt, keep the rule.

---

## 7. Outcome

4,315-line monolith → ~22–25 navigable, feature-scoped partials; identical emitted CSS (Phase 1);
smaller + dedupe + a regrowth ratchet (Phase 2). One barrel pins the cascade; the emitted-CSS diff
proves Phase 1 changed nothing a user can see.
