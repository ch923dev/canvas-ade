# Spatial Awareness — Design artifact (DRAFT — awaiting sign-off)

Layout/flow wireframes per CLAUDE.md › *Design artifact before code*. Every surface reuses an
existing component and the existing tokens (one accent `#4f8cff`, status dots only, no glow) — this
feature adds **no new modal and no new visual language**. Sign-off needed on W1–W4 before I1/I2
write UI code.

---

## W1 — Group proposal (reuses `BatchConfirmModal`, one row per proposed group)

An agent calls `group_boards` with 3 proposals. MAIN builds ONE `ConfirmBatchRequest`; the modal
already renders title · blurb · disclose · one checkbox per row · *Deny all* / *Approve N*.

```
┌─ Group 3 sets of boards ──────────────────────────────────────────┐
│ An agent proposes grouping these boards. Grouping only draws a    │
│ named outline around them — nothing moves, nothing runs. All      │
│ approved groups undo together with one Ctrl+Z.                    │
│                                                                   │
│ 1 board is already in "Docs" and stays there too.          ← disclose
│                                                                   │
│ [✓] Auth flow · 3 boards                                   ← label │
│     Terminal "claude — auth" · Browser "localhost:5173/login"      │
│     · Plan "Auth plan"        linked by: preview, same folder ← body│
│                                                                   │
│ [✓] Billing · 2 boards                                            │
│     Terminal "stripe webhook" · Plan "Billing checklist"          │
│     linked by: same folder                                        │
│                                                                   │
│ [ ] Misc · 4 boards                                               │
│     Terminal ×2 · File "README.md" · Plan "Notes"                 │
│     linked by: similar titles (low confidence)                    │
│                                                                   │
│                                   [ Deny all ]  [ Approve 2 ]     │
└───────────────────────────────────────────────────────────────────┘
```

- Row **label** = `<name> · <n> boards`; **body** = member titles (truncated to one line each type)
  + `linked by:` from `signals` (never raw paths).
- Low-confidence rows start **unchecked**; high/medium start checked. Today every row starts
  checked (`BatchConfirmModal.tsx:81`, `request.items.map(() => true)`), so I1 adds one optional
  field `preselected?: boolean` (default `true`) to `ConfirmBatchItem` — additive; `relay_prompts`
  and `publish_findings` callers are unaffected.
- `edit_groups` uses the same modal: rows read `Rename "Auth" → "Auth flow"`, `Add 1 board to
  "Billing"`, `Ungroup "Misc" (boards stay put)`.

## W2 — Tidy picker gains "Fit to screen" as the first preset (D3)

Existing `TidyMenu` (AppChrome, `T` key). One new thumbnail at the front; Smart moves to second.

```
 Tidy ▾  (T)
┌──────────────────────────────────────────────────────────────────┐
│ ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐│
│ │┌┐┌┐ ┌┐│  │▭ ▭ ▭ │  │▯ ▯   │  │▯▯▯   │  │▯▯▯▯  │  │█ ▯   │  │▦▦    ││
│ │└┘└┘ └┘│  │ ▭ ▭  │  │      │  │      │  │      │  │  ▯   │  │▦▦    ││
│ │┌┐┌┐   │  │      │  │      │  │      │  │      │  │      │  │      ││
│ └──────┘  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘│
│ Fit to     Smart     2 cols    3 cols    4 cols    Main+side  Grid  │
│ screen                                                            │
│ "Keep groups together, fit the window"          ← hint of hovered │
└──────────────────────────────────────────────────────────────────┘
```

- Fit thumbnail = small clusters separated by wider gaps (the group-as-unit idea) — drawn from
  `zones` like every other preset.

## W3 — Too many boards to read at once (D4, overflow `report`)

After a `fit` tidy whose best packing is below the readable zoom, the canvas is still arranged and
framed; one `info` toast (existing ToastIsland) explains and offers the next step.

```
                                        ┌──────────────────────────────────┐
                                        │ ⓘ Tidied 14 boards. They're too  │
                                        │   small to read at once (28%).   │
                                        │   [ Focus a group ▸ ]  [ Pages ] │
                                        └──────────────────────────────────┘
```

- **Focus a group ▸** opens the existing group switcher (`onFocusGroup`).
- **Pages** re-runs the tidy with `overflow:'pages'` (one undo step replaces the previous tidy).
- Agents get the same facts in the tool result (`readable:false`, `fitZoom`) instead of a toast.

## W4 — What "fit" does vs today's Smart (mental model, not a UI surface)

Today (Smart, 6 terminals, 2 groups) — one long terminal row, groups split across rows:

```
[B1][B2]                                   ← browsers of group A
[T3][T4][T1 A][T5][T2 B][T6]               ← every terminal in ONE row
[P1 A][P2 B]                               ← plans trail; group outlines A and B overlap
```

Fit (16:10 pane) — each group packed as a unit, units shelf-packed to the pane aspect:

```
┌ A ──────────┐   ┌ B ──────┐   [T3]
│ [B1][B2]    │   │ [T2]    │
│   [T1]      │   │ [P2]    │   [T4]
│   [P1]      │   └─────────┘
└─────────────┘                 [T5][T6]
```

## W5 — Tidy requested by a terminal agent (lead / connected tier, D1)

A single standard `ConfirmModal` (approve/deny); the orchestrator (Command board / Jarvis) path
stays un-gated as today.

```
┌─ Tidy the canvas? ───────────────────────────────────┐
│ "claude — auth" wants to rearrange 14 boards to fit  │
│ your screen (groups kept together). Sizes don't      │
│ change. One Ctrl+Z puts everything back.             │
│                                  [ Deny ]  [ Tidy ]  │
└──────────────────────────────────────────────────────┘
```

## W6 — Tidy picker gains "Arrange by role" (roles mode; its position depends on D8)

**D8 (a) decided 2026-10-16:** "By role" goes first and takes `T`, and "Fit to screen" moves to
second (so W2's "Fit first" is superseded). The thumbnail is drawn from `zones` like every
other preset: one large hero zone plus a stacked rail.

```
 Tidy ▾  (T)
┌──────────────────────────────────────────────────────────────────────────┐
│ ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐│
│ │████ ▯│  │┌┐┌┐ ┌┐│  │▭ ▭ ▭ │  │▯ ▯   │  │▯▯▯   │  │▯▯▯▯  │  │█ ▯   │  │▦▦    ││
│ │████ ▯│  │└┘└┘ └┘│  │ ▭ ▭  │  │      │  │      │  │      │  │  ▯   │  │▦▦    ││
│ │████ ▯│  │┌┐┌┐   │  │      │  │      │  │      │  │      │  │      │  │      ││
│ └──────┘  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘│
│ By role    Fit to    Smart     2 cols    3 cols    4 cols    Main+side  Grid  │
│            screen                                                          │
│ "Lead / browser gets the big slot; linked boards sit beside it"  ← hint     │
└──────────────────────────────────────────────────────────────────────────┘
```

## W7 — Roles result toast (explains what it did; one existing `info` toast)

```
┌────────────────────────────────────────────────────────────────┐
│ ⓘ  Arranged by role · hero: Browser "App" (preview of :5173)   │
│     2 more contexts off-stage: Docs, API tests                 │
│                              [ Show all ]   [ Undo ]           │
└────────────────────────────────────────────────────────────────┘
```

- **Show all** frames every unit. If that is not readable, it follows W3's existing copy.
- **Undo** is the existing one-step undo.
- No toast appears for a single unit with nothing off-stage. Silence is the success state.

The scenario wireframes S1–S15, which show where boards land, are in [`ROLE-LAYOUT.md`](./ROLE-LAYOUT.md) §7.

---

**W6 + W7 + ROLE-LAYOUT S1–S15 signed off by the user 2026-10-16.**

**Sign-off checklist:** W1 copy + low-confidence default · W2 Fit first + `T` rebound · W3 toast
actions · W5 confirm for terminal agents · **W6 By-role preset position (D8) · W7 toast copy · ROLE-LAYOUT S1–S15
landings**. Tokens: existing only.
