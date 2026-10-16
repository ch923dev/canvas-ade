# Role-aware tidy (`mode: 'roles'`) — scenario catalog + layout rules

**Ask (user, 2026-10-16):** "let's build this into a role aware kind of tidy canvas. Make sure to
plan out different scenarios, like multiple planning boards, multiple browsers, multiple terminals."

This is the **design artifact** for contracts C9 (role model) and C10 (`roleLayout()`) in
[`SPEC.md`](./SPEC.md). The wireframes below are the expected output for each scenario. Each one
becomes a **golden fixture test** in L10, and the same scenarios are the dev-check script for I2.
Sign-off on this file gates L10's template numbers and I2's UI. L9 (role derivation) does not need it.
**Signed off by the user 2026-10-16** (§7 S1–S15 as written; D7–D10 decided, see SPEC §2).

Every wireframe assumes a **16:9 pane** unless it says otherwise. Percentages are shares of the
pane after `FIT_PADDING_PX`.

---

## 1. How the layout "knows" (the three steps)

1. **Units.** Split the boards into units. Each unit is laid out on its own.
   - Named Groups and C3 contexts each become one unit.
   - **Team unit (new, roles only):** a lead, command or swarm board plus its direct orchestration
     targets form one unit, as long as those targets are not already in a Named Group. C3
     deliberately drops edges from a hub with ≥3 cables, so without this rule a lead and its
     workers would never share a unit.
   - Any board left over becomes a unit of one.
2. **Scene.** Classify each unit from its boards' roles (C9). The scene picks the hero (the board
   that gets the big slot) and the template.
3. **Slots.** Pick the template by board count and pane aspect, then fill slots in rank order.
   Boards linked to the hero sit nearest to it.

The **stage unit** fills the pane. It is the first match in this order:
1. the `primary` argument's unit;
2. the unit holding the lead;
3. the unit holding the current selection;
4. the unit holding the last-focused board;
5. the largest unit.

Every other unit is laid out compact at its own scene, placed beside the stage by C4's shelf
packer, and named in the ack hint ("2 more contexts off-stage: App, Docs").

## 2. Roles (C9) — signal → role

| Role | Signal (verified source) | Hero weight |
|---|---|---|
| `lead` | MAIN lead authority `src/main/leadAuthority.ts:52`; renderer `orchestrationStore.leadBoardId` (`src/renderer/src/store/orchestrationStore.ts:31`) | 100 |
| `swarm` / `command` | board type (`src/renderer/src/lib/boardSchema.ts:122`); a swarm with docked workers is a hub | 80 / 70 |
| `agent` | terminal `agentKind` set (`boardSchema.ts:180`), or the renderer classifies its launch line as a known agent CLI (D9: only a boolean reaches MAIN, never the line) | 60 |
| `preview` | browser (`boardSchema.ts:222`). `previewOf` = `previewSourceId` (`:226`); `callsPorts` = loopback ports its page requested (D10) | 50 |
| `plan` | planning board | 40 |
| `tracker` | kanban board | 35 |
| `dataflow` | data-flow board (bound to a browser via `sourceBoardId`, `boardSchema.ts:403`) | 30 |
| `file` | file board | 25 |
| `server` | terminal with ≥1 detected listening URL (`parsePortsFromOutput`, `src/main/portDetect.ts:66`) and no agent | 20 |
| `shell` | any other terminal | 10 |

**Links**, used for proximity in the slots:
- preview→source terminal: `previewSourceId`;
- preview→server: `callsPorts ∩ ports`;
- lead→workers: orchestration cables;
- dataflow→browser: `sourceBoardId`.

**Excluded:** docked terminals (`dockedIn`). They live inside their swarm board.

**Hero tie-break,** within the same weight: last-focused, then largest area, then id.

## 3. Scenes (per unit)

Rules are checked top to bottom; the first match wins.

| Scene | Matches when the unit has… | Hero | Template |
|---|---|---|---|
| `lead` | a `lead` | the lead | `hero-rail` (landscape) / `hero-strip` (tall) |
| `hub` | a `swarm` or `command` board | that board | `hero-rail` |
| `pair` | ≥1 `agent` **and** ≥1 `preview` | **co-heroes:** the top agent + the preview linked to it, or else the top preview | `duo-strip` |
| `stack` | ≥1 `preview` + ≥1 `server`, no agent | the preview (with ≥2 previews of one source, all are co-heroes) | `hero-rail` / `duo-rail` |
| `peers` | ≥2 terminals (`agent`/`shell`/`server`), nothing above | none (equal) | `grid` |
| `docs` | only `plan` / `tracker` / `file` / `dataflow` | none, or `primary` | `shelf` |
| `single` | 1 board | — | centred, size unchanged |

## 4. Templates (pane aspect A = w/h)

- **`hero-rail`** (A ≥ 1.3). Hero 62% wide, rail of up to 3 stacked cells. With 4–6 others the rail
  goes 2 columns and the hero drops to 50%. With more than 6, a bottom strip is added; if cells
  are still below the role minimum, the unit overflows (§6).
- **`hero-strip`** (A < 1.3). Hero on top at 65% height, then a strip of up to 4 cells, or 2 strip
  rows for more.
- **`duo-strip`**. Two co-heroes share the top 70%, with widths set by their aspect needs (a browser
  keeps its device aspect). Servers and shells go in the strip below.
- **`duo-rail`** (A ≥ 1.6, ≥2 previews). Co-heroes side by side, rail on the right.
- **`grid`**. c×r cells, choosing the c that maximizes the smallest cell's readable zoom at aspect A.
- **`shelf`**. Rows in reading order. Boards keep their size, and a wide tracker gets a full row.
- **Ultrawide** (A ≥ 2.2). `hero-rail` with the hero at 45% and a 2-column rail. `pair` becomes
  agent | preview | rail.

## 5. Sizing policy (D7)

| Class | Roles | Rule |
|---|---|---|
| flexible | terminal (all terminal roles), `swarm`, `command`, `dataflow` | w/h set to the slot, ≥ role minimum |
| aspect-locked | `preview` | sized to the device-frame aspect (`src/renderer/src/lib/browserLayout.ts:56-60`: mobile 390×844, tablet 834×1112, desktop 1280×800, qhd, uhd) inside the slot. Leftover width goes to the neighbours, so there is no letterbox gap |
| rigid | `plan`, `tracker`, `file` | **never resized**; position only. Planning elements live in board coordinates, so a shrink would crop content. The slot wraps the board's current size |

**Minimums** (world px, proposed; L10 measures them for real):
- every board: `MIN_BOARD_SIZE` 240×160 (`src/renderer/src/lib/boardDefaults.ts:11`);
- terminal readable: 480×300 (≈60 cols × 14 rows at the default font, which L10 must verify);
- tracker: `columns × KANBAN_COL_W` (200, `src/renderer/src/store/visualizeMcpApply.ts:30`).

**Screen-to-world mapping:**
1. Slots are computed in **screen px** from the pane, then converted to world units at a target
   zoom `z = min(1, the largest z that keeps every slot ≥ its role minimum)`.
2. The camera then frames the stage unit at `z`, so the arrangement fills the window. Boards look
   like 100% scale whenever they fit.
3. If `z < READABLE_ZOOM` (0.4), the unit overflows (§6).

## 6. Overflow

Fall back in this order, stopping at the first that stays readable:
1. the next denser template (`hero-rail` 1-col → 2-col → + strip);
2. the D4 overflow mode: `report` (default: arrange, `readable:false`, hint to focus the lead or a
   group), or `pages` / `shrink` when the call asks for them.

---

## 7. Scenario catalog (golden fixtures)

### S1 · lead + 2 workers (the user's first example)
```
┌──────────────────────────┬───────────────┐
│                          │ worker A      │
│   LEAD   (hero 62%)      ├───────────────┤
│                          │ worker B      │
└──────────────────────────┴───────────────┘
```
Team unit. The rail follows cable order, then reading order.

### S2 · lead + 6 workers
```
┌──────────────────────┬─────────┬─────────┐
│                      │ w1      │ w2      │
│   LEAD  (hero 50%)   ├─────────┼─────────┤
│                      │ w3      │ w4      │
│                      ├─────────┼─────────┤
│                      │ w5      │ w6      │
└──────────────────────┴─────────┴─────────┘
```
On a small pane where the w-cells fall below 480×300 at z ≥ 0.4, the result is
`readable:false` + "focus the lead" (report).

### S3 · dev stack: browser + web server + api server (the user's second example)
```
┌──────────────────────────┬───────────────┐
│                          │ web   :5173   │  ← previewSourceId (nearest)
│  BROWSER (hero, desktop) ├───────────────┤
│                          │ api   :3000   │  ← port link (D10)
└──────────────────────────┴───────────────┘
```
Without D10 the api terminal is a separate one-board unit placed beside the stage, unless a Named
Group, the same cwd, or sibling folders link it.

### S4 · agent + browser + web + api
```
┌─────────────────────┬────────────────────┐
│  AGENT (co-hero)    │ BROWSER (co-hero)  │
│                     │                    │
├─────────────────────┴──┬─────────────────┤
│ web  :5173             │ api  :3000      │   strip 30%
└────────────────────────┴─────────────────┘
```

### S5 · two browsers, one app (mobile + desktop of the same source) + web server
```
┌──────┬──────────────────────┬────────────┐
│MOBILE│ DESKTOP              │ web :5173  │
│ 9:19 │ (co-heroes, device   │            │
│      │  aspects kept)       │            │
└──────┴──────────────────────┴────────────┘
```
`duo-rail`. Both previews share `previewSourceId`, so they are co-heroes.

### S6 · two apps (2 browsers, 2 servers each, different sources)
```
┌──── unit "App A" (stage) ─────────┐  ┌─ "App B" ───┐
│ BROWSER A          │ web-A :5173  │  │ BR-B │web-B │
│                    ├──────────────┤  │      │api-B │
│                    │ api-A :3000  │  └─────────────┘
└───────────────────────────────────┘
```
Two contexts give two units. The stage is the unit with the selection or last focus; the other is
laid out compact beside it.

### S7 · 3 planning boards + 1 kanban (docs)
```
┌────────────┬────────────┬────────────┐
│ plan 1     │ plan 2     │ plan 3     │   rigid: sizes kept,
├────────────┴────────────┴────────────┤   reading order
│ KANBAN  (full row, ≥ columns×200)    │
└──────────────────────────────────────┘
```

### S8 · 4 peer agents, no lead
```
┌───────────────────┬───────────────────┐
│ agent 1           │ agent 2           │
├───────────────────┼───────────────────┤
│ agent 3           │ agent 4           │
└───────────────────┴───────────────────┘
```
`grid`, equal cells. 5 agents → 3+2, and the last row is centred.

### S9 · swarm board (docked workers) + its kanban
```
┌──────────────────────────┬───────────────┐
│  SWARM  (hero; docked    │ KANBAN        │
│  workers live inside)    │ (rigid)       │
└──────────────────────────┴───────────────┘
```

### S10 · kitchen sink: lead + 3 workers + 2 browsers + 2 servers + 2 planning + kanban
```
┌──── stage: team unit ─────────────┐  ┌─ App ─────────┐
│                     │ w1          │  │ BR │ web      │
│   LEAD (hero)       ├─────────────┤  │    │ api      │
│                     │ w2          │  ├───────────────┤
│                     ├─────────────┤  │ Docs: plan    │
│                     │ w3          │  │ plan │ kanban │
└───────────────────────────────────┘  └───────────────┘
```
The camera frames the stage. The ack says `readable:true` for the stage, with the hint "2 more
contexts off-stage: App, Docs".

### S11 · single board
Centred, size unchanged, camera fit capped at `FIT_MAX_ZOOM` (2).

### S12 · selection scope (3 boards selected out of 12)
Only the selected boards are arranged, inside their current bbox and anchored at its top-left.
Everything else stays put. The camera frames the selection.

### S13 · screen shapes (S3 and S4 on other panes)
Portrait 9:16 (S3):
```
┌───────────────┐
│ BROWSER       │
│ (hero 65%)    │
├───────┬───────┤
│ web   │ api   │
└───────┴───────┘
```
Ultrawide 21:9 (S4):
```
┌───────────┬───────────────┬────────┐
│ AGENT     │ BROWSER       │ web    │
│           │               ├────────┤
│           │               │ api    │
└───────────┴───────────────┴────────┘
```

### S14 · user override `primary` (make a planning board the hero)
The hero is that board. It is rigid, so the hero slot wraps its current size, and the rest fill
the rail or strip around it.

### S15 · 5 plain shells, no roles
Two goldens (D8 a, decided):
- explicit `mode:'roles'` → `peers` → `grid` 3+2 (flexible, resized per D7);
- implicit default (`implicit:true`: an agent omitted `mode`, or the `t` key) → the unit is all
  `shell`, so it falls back to `fit` behaviour: position only, sizes kept.

---

## 8. Guarantees (property tests, L10)

- No two boards overlap. Units never interleave (the padded bbox of A contains no board of B).
- **Rigid boards keep their exact w/h. Previews keep their device aspect** (±1px).
- Every flexible board is ≥ its role minimum, unless the result reports `readable:false`.
- The output is deterministic for any input order, and every input board gets exactly one placement.
- Docked boards are untouched.
- One undo step. Same confirm gate as `tidy_canvas` (D1).
- **The ack explains itself:** `units[]` with `{ scene, heroIds, why }`, e.g. `why: "hero = browser
  'App': preview of web :5173"`, so the agent can tell the user what happened.
