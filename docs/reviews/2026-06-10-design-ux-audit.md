# Design / UI-UX audit — 2026-06-10

> **Method:** 6 parallel read agents (app chrome+shell · shared board chrome+groups · terminal ·
> browser/preview · planning/whiteboard · cross-cutting a11y+token sweep) over the full renderer at
> `main` @ `4e646c9`, audited against the authoritative contract `design-reference/project/DESIGN.md`
> + `src/renderer/src/index.css` tokens, plus desktop UX standards (Linear / Raycast / Figma /
> tldraw / VS Code / Apple HIG).
> **Scope:** UX, UI, accessibility, performance perception, design-system consistency,
> discoverability. NOT a correctness bug hunt (that is [`2026-06-10-full-app-audit.md`](2026-06-10-full-app-audit.md), same date).
> **Tackle plan:** [`2026-06-10-design-ux-audit-waves.md`](2026-06-10-design-ux-audit-waves.md).

---

## 1. Executive summary

**Overall quality: high for a pre-1.0 desktop tool.** Token discipline ~95%, design contract
actually enforced in code. Calm/dense Linear-Raycast intent is real, not aspirational.
Architecture-level UX (snapshot/LOD preview handoff, undo checkpoint discipline, reduced-motion
gating) is senior-grade.

**Biggest strengths**
- Design-token system faithfully mirrored from contract; only ~8–10 hardcoded colors in production
  code, all localized to modals/connectors.
- Motion system disciplined: 120/200/280ms, one easing curve, `prefers-reduced-motion` honored on
  all loops + camera.
- Preview liveness model (detach+snapshot during motion) is imperceptible in normal use.
- Error copy tone: sentence-case, no "Oops", action-oriented.
- Empty state, idle terminal "Start" overlay, confirm queue — finished-feeling states.

**Biggest weaknesses**
1. **Silent save failure** — `project.save()` false → console only. Data-loss risk, zero user
   surface (AppChrome:131–135). Worst finding in audit.
2. **Discoverability debt.** Power features hidden behind unadvertised gestures: Ctrl+G group,
   Alt-drag duplicate, Shift+right-click terminal menu, double-click flip-to-recap, text-tool drag
   = area text, gear = shell config. No command palette, no shortcut legend, no onboarding.
3. **No feedback channel.** No toast system, no autosave indicator, no undo/redo UI, no loading
   state on project switch. App "goes mute" during async work.
4. **Accessibility floor not met in spots:** `--text-faint` fails AA (2.8:1), 10px micro tags on
   raised surface ~4.0:1, native preview view steals focus with no escape, recap flip leaves focus
   on hidden xterm, elements not keyboard-movable.
5. **Spec deviation:** inline board-title edit (DESIGN.md §6 mandate) not implemented for
   Browser/Planning.
6. **Bug:** `var(--text-1)` referenced in OrchestrationEdge.tsx:37 — token doesn't exist.

**Most urgent:** surface save failures → toast/feedback system → shortcut help/command palette →
contrast fixes.

**UX maturity: 3.5/5** — workflows solid, feedback + discoverability immature.
**UI maturity: 4.5/5** — token discipline, type scale, restraint excellent; a few hardcode leaks
and three duplicated modal implementations.

---

## 2. High-level product experience review

**First impressions.** Empty canvas state is correct: low-key watermark, heading, three ghost CTAs
mirroring dock. Calm, on-brand. After first board, learning curve goes cliff-shaped — nothing
teaches double-click-focus, `1`/`0`/`T` camera keys, group creation, or terminal configuration.
Tool expects tldraw/Figma literacy.

**Navigation.** Floating-island chrome matches spec and feels modern. Camera model predictable.
Gap: no minimap (spec-optional, but at >10 boards spatial memory is the only nav aid), no board
list/outline, no "jump to board" — zoom-out is the only wayfinding.

**Workflow quality.** Core loop — spawn agent terminal → detect port → push preview → plan on
whiteboard — genuinely fast once learned. Port-detect → one-tap browser-board creation is the
standout flow. Friction concentrates at configuration (gear popover, non-modal, silent discard)
and at recovery (crashed preview renderer = frozen state, no alert).

**Ease of learning: weak.** Expert ceiling high, novice floor steep. Every modern peer (Linear,
Raycast, VS Code, Figma) solves this with command palette + `?` shortcut sheet. App has neither.

**Coherence: strong.** Board-is-the-atom holds; all three types share chrome geometry, glyph
language, status-dot grammar. The canvas reads as one system.

---

## 3. Feature-by-feature audit

### 3.1 App chrome (switcher · camera cluster · dock)

**Works well**
- All controls real `<button>`s, tokens throughout, popover shadow + raised surface per §8.
- TidyMenu + BoardMenu: portaled, viewport-clamped, flip-above-on-overflow, Esc/outside/resize
  close — robust positioning.
- Menus detach live preview views while open (native-occlusion workaround).
- Grouped-focus button renders only when groups exist.

**UX problems**
- **Save failure silent** (AppChrome:131–135). High.
- Project switch: flush → dispose → load with zero loading indication. Medium.
- Undo/redo keyboard-only; no buttons, no history affordance. Medium.
- No shortcut legend / command palette. Medium.
- Audit button permanently visible bottom-left even with empty trail. Low.

**UI problems**
- Dock buttons lack `title` hints. Low.
- Project-switcher menu not viewport-clamped (BoardMenu is). Low.
- ConfirmModal scrim `rgba(0,0,0,0.5)` inline vs FullView's tokened 0.66 — two scrim darknesses. Low.

**A11y**
- ProjectSwitcher/BoardMenu items missing `role="menuitem"`; no arrow-key menu nav anywhere.
- No focus trap in ConfirmModal (destructive-gating — should trap).

**Recommended**
1. Toast/notification primitive (single component, `role="status"`, queue, auto-dismiss). Route
   save failure, export failure, screenshot, port-detect notes through it.
2. Autosave indicator: faint "Saved · 12:04" meta, recedes when idle.
3. Loading state on project switch: dim canvas + spinner in switcher pill.
4. Undo/redo affordance (or rely on palette once it exists).

**Priority: High** (save-failure surfacing lives here).

### 3.2 Shared board chrome

**Works well**
- 34px bar, glyph/tag/title, 24px actions, 1.5px accent ring, accent-wash titlebar tint —
  pixel-faithful to §6.
- States complete: rest/hover/select/focus-dim/LOD/full-view with correct 120ms ring ease, 100ms
  handle fade.
- LOD card clean; terminal keeps xterm mounted across LOD.
- 8 resize handles, SE-corner accent emphasis, min 240×160 enforced.

**UX problems**
- **Inline title edit on double-click — spec-mandated, not implemented** for Browser/Planning;
  Terminal hides it inside Configure popover. High.
- Selected vs focused visually identical (only ambient dimming distinguishes); focus-dim is
  instant, no transition.
- LOD crossover snaps with no easing — abrupt at the 40% threshold.
- Full-view exit paths (toggle icon, Esc, scrim click) — none labeled.

**UI problems**
- `var(--text-1)` undefined → selected orchestration edge renders fallback/inherit
  (OrchestrationEdge.tsx:37). **Bug.**
- Non-base-4 paddings (`8px 0 10px`, 22px LOD padding). Browser device-notch hardcoded `#15161a`.

**A11y**
- Boards not keyboard-focusable as objects — selection mouse-only; no Tab-to-board, no arrow-key
  move/resize.

**Recommended**
1. Double-click inline title edit on the bar (input swap, Enter commit / Esc cancel) + F2.
2. Define `--text-1` or fix the reference.
3. 100–120ms opacity crossfade at LOD boundary; 120ms ease on focus dimming.
4. Keyboard board model: Tab cycles boards, arrows nudge, Enter = focus, F2 = rename.

**Priority: High** (title edit + token bug), Medium rest.

### 3.3 Terminal board

**Works well**
- xterm theme mirrors tokens exactly; hinted system mono for grid (correct — webfont blurs on
  grayscale atlas).
- Status grammar complete: braille spinner + identity + `mm:ss`, dot colors per state, 2px progress
  sliver, pulse halo — all reduced-motion gated.
- Selection shim fixes coordinate mapping under camera scale; smart paste (image → staged path,
  else text, bracketed-paste safe); Shift+Enter = LF.
- Idle "Start claude" overlay — explicit, no surprise auto-spawn.
- Font sizing: three access points, 8–22 clamp, sticky default, undo-burst coalescing.
- Recap flip: 150ms fold, xterm stays mounted, reduced-motion → instant swap.

**UX problems**
- **Config popover non-modal + no unsaved-changes guard** — click-away silently discards
  shell/launchCommand edits. Medium-High.
- Shell/launchCommand setup = the product's most important configuration, behind an unhinted gear
  icon visible only on hover/select. Medium.
- Hidden gestures: double-click = flip, Shift+right-click = forced menu, long-press globe =
  multi-server picker. None advertised. Medium.
- Restart popover opens top-right over output, no auto-close. Low.
- `spawning` state shows label only — no progress sliver until `running`. Low.
- Drag-over has no drop-target highlight. Low.

**UI problems**
- xterm theme hex duplicated from tokens (necessary — canvas can't read CSS vars) — sync risk;
  needs comment-pinned single source or build-time check.

**A11y**
- Running status label not `role="status"`/`aria-live` — state changes never announced. Medium.
- After flip, focus stays on hidden xterm behind opaque recap. Medium.
- Context menu: `role="menu"` but entries lack `menuitem`, no arrow keys.
- xterm `screenReaderMode` not enabled or surfaced.

**Recommended**
1. Config popover: apply-on-close-with-confirm, or live-apply with explicit Restart CTA.
2. First-run hint: bare-shell terminal with no launchCommand shows one dismissible line in the
   well — "Set a launch command (e.g. `claude`) → ⚙".
3. `role="status"` + `aria-live="polite"` on status cluster; focus transfer on flip.
4. Sliver (slower/static variant) during `spawning`.

**Priority: Medium.**

### 3.4 Browser board / preview system

**Works well**
- Snapshot↔live handoff during pan/zoom imperceptible.
- Occlusion protections (selected-board, chrome zones, focus demotion) keep rings/menus visible.
- URL bar: draft/commit/Esc-revert, undo checkpoints, status dot semantics correct.
- Auto-reconnect with backoff; load-fail latch cleared on fresh navigation.
- Toast notes (`role="status"`, 2.5s, dismissible) for screenshot/external-open.

**UX problems**
- **No URL validation at edit time** — malformed URL fails only at load, generic "Couldn't load".
  Medium.
- **Crashed preview renderer unhandled** — board freezes silently, status never flips. Medium-High.
- Evicted (renderer closed) vs detached (snapshot) boards visually identical — interaction suddenly
  dead with no explanation. Medium.
- Auto-push port detection mutates URL bar silently in background. Low-Medium.
- Port picker: no Esc bind, no click-outside close — Cancel only. Low.
- Screenshot capture 50–200ms with no busy state. Low.
- Dimensions readout (`390 × 844`) faint mono — most users never notice. Low.

**UI problems**
- Disabled nav buttons opacity 0.4 — too subtle. No hover state on inactive viewport toggles (only
  segment in the app without one). Toast z-index 4 vs native layer works by positional luck.

**Performance**
- Reattach after eviction: 50–300ms blank while renderer spawns, no indicator — the one place the
  preview illusion breaks.

**A11y**
- Native view swallows focus permanently; Tab into frame = no keyboard way back to HTML chrome.
  High for keyboard users.
- URL input unlabeled; connection dot color-only semantics.

**Recommended**
1. Handle `render-process-gone` on preview webContents → status `crashed`, "Preview crashed —
   Reload" inline state.
2. Lightweight URL sanity check (scheme + host) with inline red border + message before commit.
3. "Resuming…" shimmer/skeleton in frame during reattach; subtle "paused" badge on evicted boards.
4. Focus-escape shortcut returns focus to board chrome from native view; document in tooltip.
5. Auto-pushed URL: flash URL bar accent-wash 600ms when value arrives.
6. Status word beside dot (`● connected`).

**Priority: Medium-High.**

### 3.5 Planning board / whiteboard

**Works well**
- Undo discipline best-in-audit: one checkpoint per gesture, phantom-step guards, transform-form
  commits surviving concurrent edits.
- Empty-note/text auto-prune; backspace-delete restores adjacent focus in checklists; checklist
  auto-grows board height.
- Text toolbar: grouped, `aria-pressed`, no-op active clicks emit no patch, viewport-clamped.
- Snapping with live accent guides, 6px zoom-stable tolerance, toggleable.
- Stroke outline WeakMap cache — dense boards stay cheap.

**UX problems**
- **Note tint not user-selectable** — cycle-on-create only; want blue → delete and re-drop until
  cycle aligns. Violates Figma/tldraw/Excalidraw expectations. High.
- **Arrow endpoints not editable post-creation**; no head/tail styles, no curve handles. High (vs
  category norms).
- Group/ungroup/lock/align/distribute are context-menu-only — no shortcuts, no toolbar. Medium.
- Tap-with-arrow-tool silently discards (sub-4px travel). Low-Medium.
- Area-text vs point-text split (drag vs click on text tool) undiscoverable. Low-Medium.
- **Export failure silent** (console only) — known gap, still open. Medium.
- Tool switch clears selection. Low.
- Toolbar only when board selected — at rest a Planning board reads as inert. Low.
- Alt-drag duplicate exists, advertised nowhere. Low.

**UI problems**
- Eraser cursor = `cell` — nonstandard. Fixed S/M/L/XL text sizes (11/13/18/26) — no custom size.
  Note tints hardcoded hex (intentional palette — document in DESIGN.md).

**A11y**
- Element move pointer-only — no arrow-key nudge. High for keyboard users.
- Right-click-only context menu — no Shift+F10/Menu key.
- Checkbox is button+span, role not announced as checkbox.
- Done-item strikethrough in `--text-faint` — below AA.

**Recommended**
1. Tint swatch row in element context menu + on note hover.
2. Arrow endpoint handles when selected (drag to rebind); defer styles.
3. Ctrl+G/Ctrl+Shift+G inside planning for group/ungroup.
4. Route export failure through toast.
5. Arrow-key nudge for selected elements (1px, Shift=10px).
6. Next maturity step: "selected-element contextual bar" (Figma pattern) — floating mini-bar above
   selection with tint/align/lock/duplicate; reuses TextToolbar's pattern.

**Priority: High** (tints + arrows are category-expectation violations).

### 3.6 Named board groups

**Works well** — full flow shipped: marquee → Ctrl+G FAB (shortcut printed on it) → naming popover →
tab with click/dbl-click/right-click verbs → absorb-on-drag with 280ms reflow.

**Problems**
- Grouping invisible until multi-select exists. Medium.
- Tab: three verbs on one target, zero affordance text. Low-Medium.
- Group tab 20px/700wt — loudest text on canvas, exceeds the type scale (max `h` = 15/600).
- Tab not keyboard-reachable (no tabIndex).

**Recommended** — palette verbs + tooltip listing the three gestures; reconcile tab type with scale.

**Priority: Low-Medium.**

### 3.7 Full view & focus

**Works well** — distinct camera-focus vs modal-full-view, both spec-clean; 200ms scale/opacity,
reduced-motion instant; Esc capture-phase beats xterm; menus portaled above scrim. Planning
full-view = camera fit (correct).

**Problems** — exit affordances unlabeled; scrim-click closes with no hint; Planning full-view
behaves differently (camera) than Terminal/Browser (modal) — same button, two mental models. Low.

**Recommended** — transient "Esc to exit" hint bottom-center on first full-view entry per session.

**Priority: Low.**

### 3.8 Modals & settings (Confirm / RecapConsent / Settings)

**Works well** — `role="dialog"` + `aria-modal` + labels; confirm queue prevents modal flap;
`role="alert"` on errors; consent-gated recap = correct privacy posture.

**Problems**
- Three modals = three hand-rolled scrim/portal/Esc implementations.
- All three hardcode scrims (`0.5`, `.45`, `0.4` black) + `#fff` text + own shadows — densest
  token-violation cluster in the app.
- RecapConsent 16px font matches no scale role.
- No focus trap, no initial-focus, no focus-restore on close.

**Recommended** — one shared `<Modal>` primitive: `--scrim` token, portal, Esc, trap, initial
focus, restore. Migrate all three.

**Priority: Medium.**

---

## 4. UI consistency audit

- **Typography** — strong. Six-role scale used app-wide; case conventions consistent. Violations:
  RecapConsent 16px (off-scale), ~20–30 inline `fontSize:` numbers that coincide with tokens but
  bypass them; group tab 20px/700 exceeds the scale entirely.
- **Spacing** — base-4 mostly held. Drift: `10px`/`18px` modal margins, `22px` LOD padding,
  `8px 0 10px` titlebar padding.
- **Color** — one-accent rule genuinely held. Violation cluster: modal scrims/white text (3 files),
  connector `#e6e6e6`/`#5a6573` undocumented (Canvas.tsx:329), danger-hover `rgba(242,84,91,.12)`
  not derived from `--err`, notch `#15161a`, ghost token `--text-1`.
- **Components** — buttons/icons consistent (1.5px stroke, 16px, currentColor). Duplication: 3
  modal implementations, 5+ menu implementations with inconsistent viewport-clamping
  (ElementContextMenu clamps well; project switcher + ExportPopover don't). Needs
  `<Modal>/<Menu>/<Popover>` primitives.
- **Interaction** — port picker = only popover without Esc/outside-close; viewport toggles = only
  segment without hover; dock = only chrome without tooltips; disabled opacity 0.4 (browser) vs
  0.35 (terminal).

---

## 5. Accessibility audit

| # | Problem | Severity | Fix |
|---|---|---|---|
| A1 | `--text-faint` #46464b ≈2.8:1 — used for watermark, done-items, hints | High | Reserve for true-disabled; bump readable uses to `--text-3`+ |
| A2 | `--text-3` on `--surface-raised` ≈4.0:1 at 10px micro tags | High | Lighten `--text-3` → ~#7b7b81 (token edit, app-wide; contract change — needs DESIGN.md sign-off) |
| A3 | Native preview view traps keyboard focus, no escape to chrome | High | Global focus-return shortcut + forward Esc outside full view |
| A4 | Elements/boards not keyboard-movable; selection mouse-only | High | Tab-cycle boards, arrow-nudge elements |
| A5 | Terminal status changes never announced | Medium | `role="status"` + `aria-live="polite"` |
| A6 | Recap flip leaves focus on hidden xterm | Medium | Transfer focus on flip, restore on flip-back |
| A7 | No focus trap / initial focus / restore in modals | Medium | Shared `<Modal>` primitive |
| A8 | Menus: missing `menuitem` roles, no arrow-key nav | Medium | Roving tabindex in shared `<Menu>` |
| A9 | Status conveyed by dot color alone | Medium | Pair dot with word or aria-label |
| A10 | Checkbox = styled button, not announced as checkbox | Low | `role="checkbox"` + `aria-checked` |
| A11 | `title=` as sole tooltip in places | Low | Add `aria-label` |
| A12 | Hover transitions + checklist progress anim not reduced-motion gated | Low | Move under media query |
| A13 | Group tab, URL input unlabeled/untabbable | Low | tabIndex + labels |

Strong base: focus-visible accent rings systematic, real buttons everywhere, dialog roles present,
reduced-motion ~90% covered. Gaps targeted, not structural.

---

## 6. Performance perception audit

**Feels fast (keep):** direct 1:1 pan/zoom, snapshot motion handoff, stroke caching, single-rAF
preview sync, 120–200ms micro-motion.

**Feels slow / heavy:**
1. **Project switch** — multi-step teardown/load, zero feedback. Reads as hang. Fix: immediate dim
   + spinner.
2. **Evicted preview reattach** — 50–300ms blank frame. Fix: keep last snapshot painted until
   `did-finish-load` of new renderer.
3. **Screenshot/export/refresh** — 50–200ms IPC, no busy affordance. Fix: pressed-state spinner.
4. **LOD snap + instant focus-dim** — discontinuities read as render hiccups. Fix: 100ms crossfades.
5. **Spawning terminal** — label only. Fix: sliver in `spawning`.

**Inefficient interactions:** naming a board (no inline edit); recreating notes to reach a tint;
sticky-tool-on-double-click convention absent for pen/note bursts.

---

## 7. Modernization recommendations

1. **Command palette (Ctrl+K)** — Linear/Raycast/VS Code core pattern. Single highest-leverage
   addition: every hidden gesture becomes a searchable verb with its shortcut printed; gives
   group/align/lock a surface; board navigation; future MCP/agent verbs get a home.
2. **`?` shortcut overlay** — keymap already centralized in useCanvasKeybindings + tools.ts; render it.
3. **Toast primitive** — exactly one transient feedback channel (Slack/VS Code/Arc convention).
4. **Selection contextual bar** (Figma) for planning elements — generalize TextToolbar's pattern.
5. **Inline rename everywhere** (F2 + double-click) — spec already mandates it.
6. **Status words beside dots** (Linear) — colorblind-safe, zero layout cost.
7. **First-run ghost hints** (tldraw onboarding) — extend the existing planning empty-state hint
   pattern to terminal launch-command + first multi-select.

Explicitly NOT recommended: sidebars, nav rails, glass/gradient trends — floating-island canvas
chrome is the correct, current pattern. Contract restraint is an asset; modernize feedback and
discoverability, not the visual language.

---

## 8. Prioritized roadmap (summary — full lane plan in the waves doc)

**Quick wins:** save-failure surface · `--text-1` fix · contrast token pass · dock tooltips ·
port-picker Esc · switcher clamp · export/screenshot failure messages · role=status additions ·
full-view Esc hint · project-switch loading state.

**Medium:** toast primitive · shared Modal/Menu · inline title edit · `?` overlay · tint picker ·
config unsaved guard · crashed-preview recovery + snapshot-until-ready · LOD/focus crossfades ·
keyboard nudge.

**Major:** command palette · keyboard-first canvas model · arrow endpoint editing + selection
contextual bar · wayfinding at scale (minimap or board list).

---

## Cross-references

- [`2026-06-10-full-app-audit.md`](2026-06-10-full-app-audit.md) — correctness hunt, same date
  (all 72 fixed via #107/#109; raw `bug-hunt-findings/` package collapsed to git history). The
  save-failure surfacing here was adjacent to that hunt's `index.ts` flushRenderer High; lanes
  coordinated.
- Contract deltas this audit proposes (need explicit sign-off before any lane builds them):
  `--text-3` value change, new `--scrim` token, `--text-1` resolution, group-tab type-scale
  reconciliation, inline-title-edit (closing an existing §6 mandate — no sign-off needed, it IS
  the contract).
