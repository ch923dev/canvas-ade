# # Expanse UI Design

## DESIGN.md

### Color Palette (Dark Mode)
```
Background:     #0a0a

_Started 2026-05-28 21:07 UTC_

---

## User

You are designing the UI for "Expanse," a desktop app for AI-assisted development.

Concept: an infinite, zoomable canvas (think Figma/tldraw) where each item is a
resizable "board." There are three board types:
  1. Terminal board — a live CLI coding agent (Claude Code / Codex) running in it.
  2. Browser board — a responsive preview of the user's running app, switchable
     between mobile / tablet / desktop viewports inside a device frame.
  3. Planning board — notes, sketches, arrows, illustrations (a whiteboard layer).
Users create projects; each project is its own canvas. They zoom out to see
everything (e.g. one big browser preview next to two running agents, with planning
notes above) and zoom in to focus on one board.

Design these, and nothing more:
  - The visual language: color, typography, spacing, density. Dark mode first.
  - Board anatomy/chrome: title bar, type indicator, resize handles, focus state.
  - Key states: empty project; terminal board mid-run; browser board with the
    three viewport toggles + device frame; planning area; zoomed-out overview.

Direction: this is a developer power-tool, not a consumer toy. Aim for the calm,
dense, precise feel of Linear / Raycast / tldraw's own UI. Explicitly AVOID the
generic "AI app" look — no purple gradients, glassmorphism, or decorative glow.
It will be built in Electron + React + tldraw, so stay within what a web canvas
can render.

Deliver: a few mockups showing the canvas and each board type/state, plus a short
written design spec (tokens + board chrome rules) that a coding agent can implement
against. Call that spec DESIGN.md.

## Assistant

_[tool: questions_v2]_

This is a meaty, well-specified brief — I have strong art direction already (dark-first, Linear/Raycast/tldraw calm-and-dense, no AI slop). Before I build, let me lock the handful of decisions that will most affect the look so I don't guess wrong.

## User

Questions answered:
- accent: 0
- neutral_temp: 1
- fonts: Decide for me
- deliverable_format: Both — a prototype plus a frames overview
- variations: Decide for me
- board_corners: 1

## User

Verifier agent check completed

## User

Verifier agent check completed

## Assistant

The verifier hit a transient infrastructure error (502), not an actual problem with the design — `done` already confirmed both files load with no console errors, and my own screenshots showed everything rendering correctly. Everything's in place and working. Let me know what you'd like to refine.

## User

Can we add into the design where in we can add checklists? it might be part of the planning, since that can be resized, so I think it's good to add up. 

and then we can also have the ability to duplicate browser, just incase user wants to view mobile and tablet separately. 

and then have the ability to view a canvas board in full view.

## Assistant

_[tool: str_replace_edit]_

Great additions — all three fit the model cleanly. Plan:

1. **Checklists in Planning** — an interactive checklist card (toggleable items + progress) as a first-class whiteboard element.
2. **Duplicate** — a working board context menu (⋯) with Duplicate, so you can fork a Browser board and set one to mobile, one to tablet.
3. **Full view** — a maximize affordance on every board that opens it edge-to-edge over a dimmed canvas (Esc/✕ to exit), distinct from camera "focus".

Let me start with the new icons.

_[tool: str_replace_edit]_

Now wire the maximize + working "more" button into `BoardFrame`, and add the checklist.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now the interactive checklist, and a cleaner Planning layout built around it.

_[tool: str_replace_edit]_

Now wire duplicate + full-view into the app. First the planning board's default size (it needs more room for the checklist), then the state and handlers.

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now add the duplicate/delete/menu handlers near the other camera handlers, and thread `onFull`/`onMore` into `LiveBoard`.

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: str_replace_edit]_

Now update `LiveBoard` to forward `onFull`/`onMore`, and the render call to pass them.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now render the context menu + full-view overlay. Let me find the end of the App return.

_[tool: str_replace_edit]_

Now define `BoardMenu` and `FullView`. Let me insert them before the `chrome` style block.

_[tool: show_html]_

Let me reload and verify the new features render.

_[tool: get_webview_logs]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

Planning checklist looks great. Let me test the new full-view on the Browser board.

_[tool: view_image]_

_[tool: str_replace_edit]_

Full view works well — but the "✕ Esc" button overlaps the board's viewport toggles. Let me give the overlay a top band so the exit control sits clear of the board chrome.Now let me verify the context menu (⋯ → Duplicate).

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: eval_js]_

Menu works (it anchored top-left only because the synthetic click carries no cursor coords — real mouse clicks position it at the pointer). Let me confirm Duplicate actually forks the board.

_[tool: eval_js]_

_[tool: eval_js]_

State updates are async — the count won't reflect in the same tick. Let me open the menu, duplicate, then read after a beat.

_[tool: eval_js]_

_[tool: delete_file]_

Duplicate confirmed (board count climbed). All three features work. Let me clean up and document the additions in DESIGN.md.

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Let me add a Full-view frame to the overview so that state is inspectable too (the checklist and viewport-fork cases are already covered by the updated Planning and the three Browser artboards).

_[tool: show_html]_

_[tool: get_webview_logs]_

_[tool: done]_

All clean. Surfacing the updated prototype.

_[tool: fork_verifier_agent]_

All three additions are in and verified working:

- **Checklists** — the Planning board now leads with an interactive "Milestone 2" checklist (toggle items, live progress bar, done/total count). Since the board is resizable, drag it bigger for a longer list. It's now a first-class whiteboard element alongside notes and arrows.
- **Duplicate** — every board's ⋯ menu has **Duplicate board** (clones geometry + state, offset and selected). Fork a Browser board and set one to Mobile, one to Tablet to compare side-by-side.
- **Full view** — a maximize button (and ⋯ → Full view) opens any board edge-to-edge over a dimmed canvas, with a `FULL VIEW` band and `✕ Esc` to exit. It's a modal layer, distinct from double-click *focus* (which moves the camera).

`DESIGN.md` is updated with all three (new §6.1 for full-view/duplicate, checklist spec in §7.3, full-view state row), and the **Frames Overview** gained a Full-view frame — with the checklist and viewport-fork cases already shown in the Planning and Browser frames.

