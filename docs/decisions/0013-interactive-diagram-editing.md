# ADR 0013 — Interactive diagram editing (whiteboard-shapes gate opened)

- **Status:** accepted (user sign-off 2026-07-24) — diagram lane Phase 4. Supersedes nothing; it is the
  gated capstone of the diagram-viz redesign (`docs/research/2026-07-19-diagram-viz-redesign/REVIEW.md`
  §3.2 FOCUS MODE, §5 Phase 4). Phases 0–3 (theming · spec+static renderer · motion/focus · MCP
  contract v2) are shipped on `main`.
- **Context:** The **whiteboard-shapes epic** (drag-and-drop shapes / a diagram palette) was
  deliberately **deferred and locked** behind an explicit gate (REVIEW §1.6 constraint 7,
  `docs/roadmap-drawio.md`): a *new ADR + explicit user sign-off*, anchored arrows first, and a
  **demonstrated Mermaid shortfall**. Phases 0–3 ARE that proof — Mermaid renders an inert `<img>`
  (its security model), so no node can ever be dragged, re-routed, or relabelled in place; the
  `engine:'expanse'` structured spec + token-native DOM renderer was built precisely to make live
  editing possible without relaxing the CSP/sanitization posture. Interactive editing now re-opens
  the deferred territory **on purpose** — this ADR is the required unlock, not a silent reversal.

## Decision

Add a **focus-mode nested React Flow editor** for `engine:'expanse'` diagram cards **only**, on
Planning boards. It is the *edit* surface of the direct-manipulation loop; the static
`DiagramSpecView` (SVG edges + token-styled divs, `pointer-events:none`) stays the **default**
render for every unfocused card (the canvas-perf contract — no always-mounted React Flow
instances; an unfocused diagram is still a handful of divs). The editor mounts only when a card
enters focus mode and unmounts on exit.

**In scope (full L-scope, per user decision at kickoff 2026-07-24):**

1. **Focus mode** swaps the static view for a nested React Flow instance inside the card, on its own
   `ReactFlowProvider`, reusing DiagramCard's existing `.nowheel/.nopan/.nodrag` carve-out so the
   nested canvas captures wheel/drag without moving the outer board camera.
2. **Drag nodes** → writes `SpecNode.pos` (board-local px; **already in the v22 schema** — no bump).
   A pinned node leaves ELK auto-layout ownership (REVIEW §3.1). **One undo step per drag** gesture
   (lazy checkpoint armed on first real move — the DiagramCard resize/arrow-endpoint discipline).
3. **Edge re-route** — reconnect an edge's endpoints between nodes; dangling refs stay structurally
   impossible (`applySpecOps` cascade + `assertDiagramSpec` rejects a dangling endpoint).
4. **Palette** — drop new nodes and pick node shape/icon **only** from the HOST `Icon` registry
   (`Icon.tsx`) and the closed `kind`/`status` vocabulary. **No freeform styling** — agents and
   users never choose raw colors (the calm contract; `specTheme` owns token mapping).
5. **Inline label editing** — edit a node's `label`/`detail` text in place; the spec's per-field
   char caps are enforced live (the same caps MAIN enforces).
6. **T3 — inline node comments → `relay_prompt` routing (INCLUDED, per user decision).** Selecting a
   node exposes a comment composer; sending routes the comment (prefilled with the node id + label
   context) to a **Terminal board's agent** as a prompt, over the existing terminal-input relay path
   (bracketed-paste framing + a single `\r`, the `relay_prompt`/voice-injection discipline — MAIN
   owns the PTY write; Browser/agent content never reaches it). Target resolution: **a picker of live
   Terminal boards on the canvas, with the last target remembered per diagram for the session**;
   comment sending is an **action, not persisted diagram state** — no new spec/element field, no
   schema bump. (The durable "owning agent" connector model is a later refinement, out of this
   phase.)

**Every edit is a spec mutation** re-validated through the existing `assertDiagramSpec` →
`boardPatch` path: undo, revision capture (`withSpecRevisions`, free), and JSON persistence all come
for free. **No new persistence machinery, no schema bump** — the whole phase reuses `pos` (already
present), the closed `kind`/`status`/`icon` vocab, and `applySpecOps` semantics.

**Explicitly NOT in scope (kept deferred / locked):**

- **T1 — per-diagram Tweaks row** (direction/density/theme quick controls). **Left out** (user
  decision). The locked "Tweaks panel: cut entirely" decision **stands unamended** by this ADR;
  direction/theme remain chosen at creation or by the agent. A narrow re-open, if ever wanted, needs
  its own ADR note.
- **Mermaid (`engine:'mermaid'`) cards stay inert images** with **zero source-editing affordances on
  expanse cards** — the `diagram.e2e.ts` pin that asserts no "Edit source" button on an expanse card
  stays green. Mermaid keeps only its existing `</>` textarea + `⧉` convert action.
- Any interactive editor for sequence/gantt/ER (Mermaid) diagrams — the roadmap-drawio gate logic
  reused; revisit only on demonstrated need.

## Consequences

- **Security posture is unchanged and reinforced.** The editor renders the same short typed spec
  strings as React text nodes — no `innerHTML`, no SVG sanitization question, no `unsafe-eval`, no
  hidden window. React Flow is already the app's bundled canvas engine (zero new bytes); no new
  runtime dependency is expected.
- **Perf contract holds.** Static-by-default, editor-on-focus means an off-screen or unfocused
  diagram never mounts a React Flow instance; the existing paint-gate/liveness discipline is
  untouched.
- **The whiteboard-shapes epic gate is now formally OPEN for `expanse` diagrams** — but only within
  the closed vocabulary above (no freeform shapes/colors), so the calm-UI contract is preserved. The
  general whiteboard-shapes epic (arbitrary shapes on the Planning canvas itself) remains separate
  and out of scope here.
- **T3 introduces a diagram→agent action edge.** It reuses the vetted terminal-input relay (MAIN-only
  PTY write, trusted-user input only); it does not weaken sandbox/isolation and adds no new persisted
  state. The "which agent owns this diagram" question is answered by an explicit picker for now; a
  durable connector model is a deliberate follow-up.
- **No schema migration.** `pos` is pre-existing (v22); all other edits reuse existing fields and the
  Phase-3 `applySpecOps` apply semantics. Older builds open new docs unchanged (a hand-placed `pos`
  simply overrides auto-layout, which any spec-aware reader already honors).
- **Undo/agent interleave** is defined: a drag gesture = one checkpoint; an inline edit session = one
  commit; agent `specOps` land as their own tracked commit — the existing revision rail covers
  peeking across both. e2e pins the "one undo step per drag" and the interleave.

## Interaction decisions (design mock signed off 2026-07-24)

The token-faithful mock (`docs/research/2026-07-19-diagram-viz-redesign/phase4-design/mock.html`) was
approved. Settled surface choices:

- **Entry:** BOTH a `✎ Edit` toggle on the selected card's header AND double-click-a-node to enter
  focus mode with that node ready to edit. Mermaid cards get no `✎` (zero-source-edit pin holds).
- **Palette:** a **floating rail** overlaying the canvas (top-left), not a docked strip — it does not
  shrink the editable area.
- **T3 target:** a picker of live Terminal boards with the last target **remembered per diagram for
  the session** (v1); a durable "owning agent" connector is a deliberate later refinement.
