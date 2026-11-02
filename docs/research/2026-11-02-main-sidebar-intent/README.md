# "Make X the main one" — main + sidebar layout intent (research, 2026-11-02)

**Trigger:** I2 dev check, step 6. Asked "make the browser the main one", Jarvis made the browser
the hero of its OWN unit. On an ungrouped canvas that unit is the browser alone, so it stayed at
its size, the camera zoomed onto it, and every other board went off-stage. The user expected
**main + sidebar**: the browser large, and every other board in a side column.

## 1. Root cause (verified in code + sim)

- ROLE-LAYOUT §1 picks the **stage unit** by "primary's unit > lead > selection > …". `primary`
  only picks the hero *inside* its unit (S14). Units come from Named Groups and C3 contexts, and
  any leftover board becomes a unit of one.
- Sim of the dev-check canvas (2 claude terminals in one cwd, 1 browser, 1 planning board, no
  groups), `runTidy({ primary: browser })`. Units = `single:browser`, `peers` (2 terminals) and
  `single:planning`. The browser was **"kept at its size"** (700×500) and the camera zoomed to it
  at 1.34.
- The same canvas with **all boards in ONE unit** gives main + sidebar from the existing
  `hero-rail` / `hero-strip` templates:
  - 1500×800 pane: browser 1464×1046 on the left (~68 % of the width); terminals and the planning
    board stacked in a right column.
  - 800×1000 pane: browser on top; a strip below.
  - With 7 boards the rail grows to 2 columns.

  **The engine can already draw it. The defect is the unit semantics of `primary`, and a tool
  surface that hides the intent behind an optional knob.**

## 2. Prior art — "promote to main" in tiling window managers

| WM | Command | Scope | Old main goes… | Params / defaults |
|---|---|---|---|---|
| dwm | `zoom()` → `pop()` | **all** tiled clients on the monitor | to the top of the stack (order kept) | `mfact` 0.55 (clamp 0.05–0.95), `nmaster` 1; stack split equally |
| xmonad | `swapMaster` / `shiftMaster` (`Tall`) | whole workspace | swap into the target's slot / shift down, order kept | ratio 1/2, nmaster 1, delta 3/100; `Mirror` = wide |
| Hyprland (master) | `layoutmsg swapwithmaster`, `orientationleft/right/top/bottom/center`, `mfact` | whole workspace | swap | mfact 0.55; orientation default left; centre needs ≥ 2 slaves |
| Amethyst | "swap focused window with main" + layouts Tall / Tall-Right / Wide / 3Column-Middle | whole space | swap | side chosen by LAYOUT, not by a param |
| komorebi | `promote` ("to the largest tile") | workspace | re-inserted (others shift) | no params; side from the layout |

Sources: git.suckless.org/dwm `dwm.c` (zoom/pop/tile/setmfact); xmonad `StackSet.hs` and
`Layout.hs`; wiki.hypr.land Master-Layout; Amethyst README; komorebi `docs/cli/promote.md`.

**Takeaways:**
- The command acts on **every** tiled item, as one flat list, never only the target's cluster.
- Parameters: target, side (left / right / top / bottom), ratio (~0.55, clamped), master count.
- The stack is split equally.
- Promoting the item that is already main is idempotent; a no-op is the least surprising.
- None of these WMs has undo. We already have one-step undo.

## 3. Prior art — focus layouts in apps

- **LiveKit `FocusLayout` + `CarouselLayout`** (components-js): the strip is vertical when its box
  is taller than wide and horizontal otherwise. Strip tiles are equal and **aspect-locked (16:10)**.
  `tilesThatFit = round(length / tileSpan)` with ±0.5 hysteresis. Overflow scrolls.
- **Jitsi filmstrip + large video:** one strip dimension is fixed (vertical width ≥ 120, capped so
  the stage stays ≥ 800 px). The other dimension follows each tile's aspect. Overflow scrolls
  (virtualized).
- **FancyZones** ships a `focus` template. **Rectangle** names every preset by its outcome
  (`first-two-thirds`, `center-prominently`, …), one action per outcome.

**Takeaways:**
- The main item takes the leftover space; the strip gets a clamped share.
- Strip tiles keep their aspect.
- The side follows the pane aspect: right when wide, bottom when tall.
- Overflow wraps, scrolls or shows "+N"; it never shrinks tiles below a minimum.

## 4. Prior art — tool design for agents

- Anthropic, *Writing effective tools for agents*: "building a few thoughtful tools targeting
  specific high-impact workflows"; "Too many tools or overlapping tools can also distract agents";
  "Avoid ambiguity by clearly describing (and enforcing with strict data models) expected inputs";
  "Even small refinements to tool descriptions can yield dramatic improvements".
- OpenAI function calling: "Use enums and object structure to prevent invalid states"; "Include
  examples and edge cases"; "Don't make the model fill arguments you already know"; keep it to
  fewer than ~20 functions.
- Comparable MCP servers expose **one tool per user-visible intent**: Excalidraw MCP
  (`align_elements`, `distribute_elements`), the tldraw agent kit (separate `align` / `distribute`
  / `stack` actions), Rectangle (named presets). The i3 / Hyprland MCPs instead use action-param or
  raw-passthrough tools, the ambiguous style.
- Our `tidy_canvas({ mode?, …, primary? })` is the anti-pattern: a **required intent hidden as an
  optional knob on a general tool**. The model must also know that `primary` means "hero of its
  unit", which nobody would guess.

## 5. Recommended design

1. **Engine — `main` layout ("Main + sidebar"):**
   - The target is the main board. **Every in-scope board** (default: all undocked boards on the
     canvas, as in the WMs) forms ONE unit with the target as its hero, reusing roleLayout's
     `hero-rail` / `hero-strip` (wide pane → sidebar right; tall → bottom; optional `side`
     override).
   - The sidebar order is the boards linked to the target first, then role rank (the existing
     `orderOthers`).
   - **Every board in it is resized** (user decision, 2026-11-02 dev check — supersedes D7 for main
     + sidebar only): the main board stretches to fill the main area whatever its type (a
     browser's page frame keeps its device size inside), and every sidebar board — planning,
     kanban and file included — is resized to an even sidebar slot. By role and Fit to screen
     still never resize planning / kanban / file boards. One undo step restores every size.
   - Overflow: the rail wraps to 2 columns, then `readable:false` → the W3 toast.
   - One undo step; the camera frames the result.
   - Ack: `{ moved, main: "browser 'App'", sidebar: [titles], side, fitZoom, readable }`.
2. **Jarvis:** a dedicated `make_main_board({ board, side? })` tool. Its description spells out the
   geometry and carries the example "make the browser the main one". `tidy_canvas` stays for
   "tidy up" and **loses `primary`**, so the two tools do not overlap. Host-only change, no
   package publish.
3. **MCP agents:** short term, the host gives `tidy_canvas`'s `primary` the main + sidebar meaning,
   with no wire change. Later, a dedicated `arrange_main_board` tool in `@expanse-ade/mcp` (a
   package release, user-gated).
4. **UI:**
   - a **"Main + sidebar"** preset in the Tidy picker, using the selected board (disabled with a
     hint when nothing is selected);
   - a **Make main** entry on the board context menu;
   - a design artifact (animated scenario) before any code.
5. **Eval guard:** a phrase set ("make X the main one", "put everything else on the side", "focus
   on the browser") asserting that Jarvis picks `make_main_board`.
