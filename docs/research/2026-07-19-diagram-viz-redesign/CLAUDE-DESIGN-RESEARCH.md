# How Claude Does Design — Research + Borrow Map for the Diagram Redesign

**Date:** 2026-07-19 · **Companion to:** `REVIEW.md` (the Direction-C decision doc)
**Question:** how do claude.ai Artifacts and Claude Design actually produce/iterate designs, and
which of their features should Expanse's diagram/visualization layer borrow?

## 0. Sources & confidence

Unusually strong primary access for this question:

- **First-party, in-hand:** this repo's `design-reference/` bundle **is a Claude Design export**
  (DESIGN.md + JSX prototype + `tweaks-panel.jsx` + the full design chat in `chats/chat1.md` showing
  the `questions_v2` and verifier-agent tools live). We hold a real sample of the product's output.
- **Primary, local:** Anthropic's actual design skills shipped in this Claude Code install —
  `frontend-design` (official plugin), the built-in `artifact-design` and `dataviz` skills (read
  verbatim), plus the third-party `impeccable` plugin (part of this project's design toolchain,
  not Anthropic's).
- **Official published:** Anthropic's Claude Design announcement + Help Center (2026-04-17 launch),
  the frontend-design skill repo + blog, the "Prompting for frontend aesthetics" cookbook, the
  `theme-factory` skill, the Artifacts engineering interview (Pragmatic Engineer), the
  interactive-visualizations blog, artifacts user docs.
- **Leaked/reverse-engineered (flagged, medium/low confidence):** artifacts system-prompt dumps
  (artifact types, update-vs-rewrite mechanics, library allowlist). Internally consistent across
  independent extractions; not Anthropic-authoritative.

---

## 1. The method — how Claude designs, distilled to seven pillars

### P1 · Tokens-first design plan, then self-critique, then code
Every Anthropic design surface runs the same two-pass loop: **sketch a compact token system first**
(4–6 named colors, 2+ type roles, a one-sentence layout concept, one signature element), then
**critique that plan against the brief before building** — "if any part of it reads like the generic
default you would produce for any similar page, revise that part, and say what you changed and why."
Code only after the plan survives. (frontend-design + artifact-design skills, verbatim.)

### P2 · Lock load-bearing decisions before generating
Claude Design's `questions_v2` step interrogates the user on the few choices that most affect the
look — accent, neutral temperature, fonts, corner radius, deliverable format — *before* the first
render. Seen live in our own `chats/chat1.md`. Decisions land in the written contract; later
iterations never re-litigate them.

### P3 · The design system is an ingested, enforced contract
Claude Design onboards by **reading the codebase + design files and building a design system from
both**; thereafter it "checks its own output against your design system, and makes corrections
before you see them" (official Help Center). The exported DESIGN.md is an *implementation contract*
— tokens + rules + rationale in one file — exactly the pattern this repo already lives under
(`design-reference/DESIGN.md`, mirrored into `tokens.css`). Reviewers consistently rate this
ingestion/coherence as the product's best-in-class feature.

### P4 · Verify by computing and by looking — never by taste
Three distinct verification layers appear everywhere:
- **Verifier agents** screenshot the output and check console errors before "done" (chat1.md).
- **Deterministic validators**: the dataviz skill's rule is "the color part is computable, so
  compute it" — a runnable palette validator (OKLCH lightness band, chroma floor, CVD ΔE ≥ 8 under
  simulated protanopia/deuteranopia, normal-vision floor ≥ 15, contrast vs surface) gates every
  categorical palette. Hard FAIL = don't ship.
- **Design-lint hooks**: the impeccable detector auto-scans edited UI files and flags slop patterns
  as reminders (we experienced it flagging this very session's files).

### P5 · An iteration-surface gradient, not one big "regenerate"
Claude Design offers **six escalating edit surfaces**: chat (broad/structural), inline click-on-
component comments (targeted, batchable), direct text/property editing, a **Tweaks panel** (live
sliders for spacing/color/density with no regeneration), draw-mode annotations, present mode.
Artifacts got the same idea textually in ~Oct 2025: an `update` command (`old_str`/`new_str`,
"fewer than 20 lines and fewer than 5 distinct locations", max 4 calls/message, old_str must match
exactly once) vs `rewrite` for structural change — reported ~3-4× faster iteration and it preserves
in-memory state because the artifact isn't re-mounted. Plus a **version selector** and a
publish/remix loop.

### P6 · Aesthetic doctrine: restraint as the current direction
Anthropic's guidance *evolved*: the Claude-4-era artifacts prompt leaned "bold and unexpected...
wow factor" (leaked, 2025); the 2026 skills teach the opposite failure mode — they name the
"AI slop" fingerprints (cream+serif+terracotta, near-black+acid-green, purple gradient on white,
Inter/Space Grotesk reflex, eyebrow labels, numbered sections, side-stripe cards, identical card
grids) and preach: **spend boldness in one place, keep everything else quiet**; dominant color +
sharp accent beats evenly-distributed timid palettes; one orchestrated motion moment beats
scattered micro-interactions; `prefers-reduced-motion` is non-optional; copy is design material;
semantic color (good/warn/critical) is separate from the accent and never counts as decoration.
Root-cause diagnosis (official blog): "distributional convergence" — absent strong direction the
model samples the statistical center of web design. The skills exist to force *chosen* defaults.
Our repo's calm/dense/one-accent contract is squarely the 2026 doctrine.

### P7 · Rendering architecture: sandboxed, self-contained, allowlisted
Artifacts render in a **sandboxed iframe with full-site process isolation** and a strict CSP
(Anthropic engineering, official). Content must be self-contained single files; libraries come only
from a pinned allowlist (React, recharts, d3, three r128, lucide…; Tailwind utilities only — no
compiler); no localStorage. Mermaid is a first-class artifact type (`application/vnd.ant.mermaid`)
but renders as a **static diagram with generic chrome — no native pan/zoom** found. The newer
"interactive visualizations" feature (2026-03) explicitly does NOT extend Mermaid: it builds
charts/diagrams as **HTML + SVG in a sandboxed iframe**, inline and ephemeral. Claude Design's
handoff bundle to Claude Code is a **machine-readable component spec + design tokens + layout
hierarchy + assets** — structured data, not screenshots.

---

## 2. Validation of our current plan (things we independently got right)

| Ours (REVIEW.md / shipped Phase 0) | Their equivalent |
|---|---|
| Hidden sandboxed worker, strict scoped CSP, inert SVG, vendored pinned Mermaid | Artifacts' iframe isolation + CSP + pinned-library doctrine — same posture |
| Tokens → `themeVariables`/`themeCSS`; agents write `:::done`, host owns color | Claude Design's "checks its own output against your design system"; dataviz "text wears text tokens, never series color" |
| Direction C: structured `DiagramSpec`, DOM renderer, Mermaid kept static for long-tail | Anthropic's own trajectory: interactive viz = HTML/SVG DOM, **not** Mermaid augmentation; Mermaid stays static even on claude.ai |
| MCP `specOps` incremental updates by stable id | Artifacts' `update` (old_str/new_str, capped) vs `rewrite` split — the exact same shape, and it's what made their loop feel 3-4× faster |
| Confirm-gate showing full content / semantic diff | Their human-in-the-loop review + "every element should earn its place" |
| Phase-0 reduced-motion mandate | "Reduced motion is not optional" — universal across their skills |
| Design-artifact-before-code + plan-viz rituals | P1/P2 exactly; `questions_v2` = our AskUserQuestion sign-off |

Our Phase-0 diagram card already **exceeds** claude.ai's native Mermaid UX (they have no pan/zoom,
no semantic status classes, no motion).

## 3. The borrow list — features to adopt, mapped to phases

**B1 · Palette validator as a unit test (dataviz P4). Phase 1, cheap, do first.**
Port the six-checks method: a test that computes contrast + CVD ΔE for the five status colors on
`--surface`/`--surface-raised` (light+dark when a light theme ever lands) and FAILS the build if a
token edit breaks separability. Extends our existing ER-contrast e2e philosophy from one hard-coded
case to a computed gate. Also adopt: **status ships with icon + label, never color alone** — add
per-status glyphs (✓/●/!/✕) in the spec renderer (SVG `<text>`/tspan, which Mermaid-in-`<img>`
couldn't do with CSS `::before`).

**B2 · Update-vs-rewrite thresholds in MCP v2 (P5). Phase 3 design detail.**
Keep `specOps` (validated), and borrow the *rules that made theirs work*: op batches capped per
call; upserts must reference existing ids (their "old_str must match exactly once" uniqueness
discipline → our dangling-ref rejection); tool docs state "use specOps for < N changed nodes, full
`spec` rewrite for structural change." Confirm modal renders the diff either way.

**B3 · Iteration-surface gradient for diagrams (P5). Phases 2–4.**
Map their six surfaces onto the diagram card:
- *chat/agent* = MCP specOps (Phase 3);
- *inline comment* = click a node → comment box → routes to the owning Terminal agent as a
  `relay_prompt` prefilled with node id/context (Phase 4+, needs its own design pass);
- *direct edit* = drag/pin nodes, inline label edit (Phase 4, ADR-gated);
- *Tweaks* = per-diagram quick controls (direction, density, theme preset) — ⚠ see tension T1;
- *draw* = already exists (the Planning board IS a whiteboard around the diagram);
- *present* = focus/expand mode (Phase 2 click-to-focus).

**B4 · Spec-level version history (P5). Phase 2–3, cheap because of content-addressing.**
Artifacts' version selector, element-scoped: keep the last N specs (or Mermaid sources) on the
element (`revisions: [{spec|source, ts, author: 'agent'|'user'}]`, capped), with a small version
scrubber in the card header. Derived SVGs are already content-addressed so old renders cost
nothing. Gives the user "the agent rewrote my diagram — show me what changed / go back" — the
single most-praised artifacts UX affordance, and a natural fit for our undo-averse untracked
cache discipline (revisions ride the tracked spec commit).

**B5 · Verifier pass on agent-written diagrams (P4). Phase 3.**
After MAIN validates a spec structurally, run a cheap **diagram lint** before the confirm modal:
orphan edges, disconnected nodes, > caps, label overflow estimates, palette-contrast recompute.
Findings render as warnings *inside the confirm body* ("⚠ node `deploy` unreachable") — the human
approves with eyes open. This is their verifier-agent idea made deterministic and free.

**B6 · Named theme presets with confirm-before-apply (theme-factory). Phase 2+, package story.**
The spec gets an optional `theme` naming a preset from a host registry (calm-default + 2–3
restrained alternates); unknown name ⇒ default (the backdrop-scene registry discipline, ADR 0006).
Directly feeds the open-source `@expanse-ade/diagram` pitch: themes = the swappable parameter set,
method invariant — exactly how dataviz frames "plugging in a design system."

**B7 · Handoff-bundle framing for the MCP contract (P7). Phase 3 docs.**
Claude Design's handoff = spec + tokens + layout + assets, explicitly so the consumer "reads
structured spec output... rather than inferring intent from pixels." Use this framing in the MCP v2
tool docs: the spec is the *handoff artifact*; token names (status/kind enums) are the vocabulary;
raw Mermaid is the legacy/pixel path. Also: `canvas://board/{id}/planning` returning the full spec
= their "remix" (any agent can read → modify → propose).

**B8 · Aesthetic doctrine into `specTheme.ts` (P6). Phase 1–2, mostly free.**
Encode as code/review checklist: accent on `active` only (have it); status color always paired
with glyph (B1); one orchestrated entrance stagger, no per-node scatter; node-label copy rules in
MCP tool docs (verb-first, ≤ 4 words, no emoji — their "words are design material"); density over
decoration; no gradients/glow (repo law already).

## 4. Tensions to resolve (user calls, not silent adoptions)

**T1 — Tweaks panel was CUT (locked decision).** Repo law: "Tweaks panel: Cut entirely. Ship fixed
default tokens." Claude Design's Tweaks panel is one of its best-reviewed loops. Options: (a) keep
the cut — global tweaks stay dead, diagram presets chosen only at creation/via agent (default,
no re-decision needed); (b) narrow re-open: per-diagram-element quick controls (direction/density/
theme), NOT global theming — needs an ADR note since it grazes the locked decision. Recommend (b)
considered at Phase 4 alongside the whiteboard-shapes ADR, not before.

**T2 — "Wow factor" vs calm.** The leaked artifacts prompt's "bold/glassmorphism/wow" era is
exactly what DESIGN.md bans. Anthropic themselves moved to restraint in 2026. Resolution: borrow
their *method* (P1–P5, P7) everywhere; borrow their *2026 doctrine* (P6); ignore the 2025 "wow"
guidance. No change to our visual contract.

**T3 — Inline-comment-on-node routes to WHICH agent?** Claude Design has one implicit agent; our
canvas has many terminals. Needs the orchestration-connector model (comment routes over the
existing connector to the diagram's owning agent, else a picker). Defer design to Phase 4; note on
the plan board.

## 5. Concrete next actions (roadmap deltas)

1. **Phase 1 add:** status-palette validator unit test + status glyphs in the spec renderer (B1).
2. **Phase 2 add:** spec revision history + version scrubber (B4); theme-preset registry (B6).
3. **Phase 3 add:** diagram lint in the confirm path (B5); specOps caps + update-vs-rewrite rule in
   tool docs (B2); handoff framing in MCP docs (B7).
4. **Phase 4 add:** iteration-gradient design pass — inline node comments + (pending T1/ADR) the
   per-diagram Tweaks row (B3).
5. **No change:** engine direction, security posture, calm doctrine — all independently confirmed
   by how Anthropic builds the same class of thing.

---

## 6. Source appendix

Official: anthropic.com/news/claude-design-anthropic-labs · support.claude.com "Get started with
Claude Design" + "What are artifacts" · claude.com/blog/improving-frontend-design-through-skills ·
claude.com/blog/claude-builds-visuals · claude.com/blog/artifacts · platform.claude.com cookbook
"Prompting for frontend aesthetics" · github.com/anthropics/skills (frontend-design, theme-factory)
· newsletter.pragmaticengineer.com "How Anthropic built Artifacts" · claude.com/connectors/mermaid-chart.
Local primary: this install's `artifact-design`, `dataviz` (+ `references/color-formula.md`,
`validate_palette.js`), `frontend-design` SKILL.md; repo `design-reference/` (Claude Design export);
`impeccable` plugin (third-party).
Leaked/unofficial (flagged): CL4R1T4S artifacts prompt dumps · simonwillison.net Claude-4 prompt
teardown · hyperdev.matsuoka.com on the Oct-2025 update mechanics · community DESIGN.md ecosystem
(designmd.co, VoltAgent/awesome-claude-design). Reviewer takes: builder.io, macstories.net,
flowstep.ai (competitor — bias noted), victordibia.com.
