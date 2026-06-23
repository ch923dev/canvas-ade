Now I have the authoritative tokens. Let me do a thorough audit of both mocks against the contract.

The key violation class to hunt: the **JSON syntax-highlighting colors**. DESIGN.md is explicit — "One accent, used functionally only... Everything else is neutral grey." The mocks introduce custom green/amber/violet/blue value colors for typed JSON, which is exactly the "rainbow-syntax" violation the user is asking about.

Let me compile the exhaustive findings.

# Token-Fidelity & On-Brand Audit — Mocks A & B

## Verdict

Both mocks nail the surface/border/text/radius tokens and the chrome geometry. **The single systemic violation in both is rainbow JSON/type syntax coloring** — DESIGN.md §1.2 is explicit: "One accent, used functionally only… Everything else is neutral grey." Off-palette greens/ambers/violets/blues used to *type-code values* are decoration, not function, and must collapse to the neutral ramp (with `--accent` reserved for keys/links only, and status hues reserved for status only). Secondary issues: a few off-token method-tint colors, two glow/box-shadow-ring flourishes, one wrong status-dot semantic, and a handful of off-scale font sizes.

---

## MOCK A (JSON viewer)

### Critical — rainbow syntax (off-brand, off-token)
These hexes exist nowhere in the token set and are pure type-coloring decoration:

| Selector | Offending value | Fix |
|---|---|---|
| `.v-str` | `#9fc6a8` (green) | `--text` `#ededee` (string values are primary content) |
| `.v-num` | `#c7b07a` (amber) | `--text` `#ededee` |
| `.v-bool` | `#a89cd6` (violet) | `--text` `#ededee` (or `--text-2` to de-emphasize literals) |
| `.badge.str` text+border | `#9fc6a8` / `rgba(159,198,168,.2)` | text `--text-3`; border `--border-subtle` |
| `.badge.num` text+border | `#c7b07a` / `rgba(199,176,122,.2)` | text `--text-3`; border `--border-subtle` |
| `.badge.bool` text+border | `#a89cd6` / `rgba(168,156,214,.2)` | text `--text-3`; border `--border-subtle` |
| `.ba-after .v-str` (inline, before/after panel) | inherits `#9fc6a8` | `--text` |
| `.ba-after .v-num` (inline) | inherits `#c7b07a` | `--text` |

Type differentiation should come from the neutral ramp + the existing `.badge` chips (which read fine once their borders/text are neutralized), not from hue. Keys (`.k`) already use `--accent` — keep that as the ONE functional accent; everything else neutral.

### Warning — status hue used non-functionally
- `.reqrow .m.post { color: var(--ok) }` — `--ok` (green) is a **status** token ("running/success status dot," §2). Tinting the POST HTTP-method label green is decorative status-color use. GET already uses `--accent` (also questionable, but accent-as-active is defensible for the selected verb). **Fix:** both method labels → `--text-2`, or only the *selected* row's method → `--accent`. Reserve `--ok`/`--warn`/`--err` for the actual `.st` status-code column (which correctly uses them).

### Warning — glow/ring flourish
- `.seg button.on { box-shadow: inset 0 0 0 1px var(--border) }` — an inset ring on the active segment is an extra elevation the system doesn't define (§4: the *only* shadows are board-resting and popover). The active segment already has `--surface-overlay` + `--text`. **Fix:** drop the box-shadow; if separation is needed, use a 1px `--border-subtle` border instead of an inset ring.

### Minor — off-scale font sizes
The type scale is 10/11/12/13/15px only (`micro`/`meta`/`label`/`body`/`h`). Fractional sizes are off-spec:

| Selector | Value | Fix |
|---|---|---|
| `.tree` | `font-size:11.5px` | `11px` (`meta`) |
| `.ba-body` | `font-size:10.5px` | `10px` (`micro`) |
| `.ba-after .v-str` etc. font hints | various `font-size:8px` on `.tri` | `9px` floor is already used elsewhere; `8px` is below the 10px on-canvas minimum — acceptable only as a sub-glyph decoration, but prefer `9px` |
| `.tri` (`9px`), `.badge`/`.count`/`.annot`/`.showmore`/`.gutter` (`9–10px`) | 9px on glyphs | Acceptable: these are sub-micro glyph/affordance marks, consistent with B. Flagging `8px` (`.ba-after .tri`) as the only true under-floor value → raise to `9px`. |

### Minor — decorative underline
- `.v-url` uses `text-decoration-color: var(--border-strong)` and `.showmore` uses `border-bottom:1px dotted var(--border-strong)` — these are fine (neutral, functional link affordance). No change. `.v-url` color `--accent` is correct (links = accent).

### Pass
- All surfaces (`--void`/`--surface`/`--surface-raised`/`--surface-overlay`/`--inset`), borders, text ramp, radii (`8/6/5/999`), `--accent`/`--accent-wash`, and the `.st.warn/.err` status codes are all on-token. Selected-row `::before` 2px accent bar and `--accent-wash` fill are correct functional-accent usage.

---

## MOCK B (data flow)

### Critical — rainbow method/type tints (off-token, decorative)
Mock B introduces a *new* palette of muted-but-still-chromatic colors that aren't in the token set, plus blends status hues into non-status roles:

**Method tints (off-token hues + tinted fills/borders):**
| Selector | Offending values | Fix |
|---|---|---|
| `.m-get`, `.gnode.endpoint .m`, `.endpoint-chip .m.get` | `#8fb4ff` text + `rgba(79,140,255,.08)` fill + `rgba(79,140,255,.22)` border | `#8fb4ff` is an off-token lightened accent — use `--accent` `#4f8cff` for text; fill `--accent-wash`; border use `--border-subtle` (don't invent `rgba(79,140,255,.22)`). Even better: methods are not "active" — neutralize text to `--text-2`, reserve accent for the *selected* path only. |
| `.m-post`, `.endpoint-chip .m.post`, `.role.produces` | `#7fd6a8` text + `rgba(62,207,142,.07/.08)` fill + `rgba(62,207,142,.2)` border | `--ok` is status-only. POST-as-green is decorative. **Fix:** text `--text-2`; drop the green fill/border (use `--surface-raised` + `--border-subtle`). |
| `.m-ws` | `#c9b2e8` text + `rgba(150,110,220,.08)` fill + `rgba(150,110,220,.22)` border | Violet is **entirely off-palette** (no purple anywhere in tokens; §1.3 explicitly bans purple). **Fix:** text `--text-2`; neutral `--surface-raised`/`--border-subtle` chrome. |
| `.role.consumes` | `#8fb4ff` + `rgba(79,140,255,.08)` | Neutralize → `--text-3` on `--surface-raised`; role distinction via the label text, not hue. |

**Type-token syntax colors (same rainbow violation as A):**
| Selector | Offending value | Fix |
|---|---|---|
| `.fields .t-string`, `.field-line .ft .t-string` | `#9db8d8` (blue-grey) | `--text` |
| `.fields .t-number`, `.t-number` | `#cdb892` (amber) | `--text` |
| `.fields .t-bool`, `.t-bool` | `#9bc7a8` (green) | `--text` |
| `.fields .t-id`, `.t-id` | `#a99bd6` (violet — banned hue) | `--accent` would be defensible for an ID/foreign-key type *if* lineage is the functional signal; otherwise `--text`. Pick one and drop the violet. |

Keys (`.fields .key` = `--text`, `.opt`/`.colon` neutral) are correct; only the *type* tokens are rainbow.

### Warning — glow ring on selected node (flourish)
- `.gnode.on { box-shadow: 0 0 0 1px var(--accent) }` plus `border-color: var(--accent)` — a 1px accent box-shadow *on top of* an accent border reads as a glow/double-ring. DESIGN.md §6 defines the selected treatment as a single **1.5px `--accent` ring** (`box-shadow: 0 0 0 1.5px --accent`) with **no extra shadow**. **Fix:** use the canonical `box-shadow: 0 0 0 1.5px var(--accent)` and let the border stay at rest (`--border`), or keep the accent border and drop the box-shadow — not both.

### Warning — off-token connector color
- `:root { --connector: rgba(255,255,255,.13) }` — DESIGN.md §2 defines `--connector: #5a6573` (orchestration-connector). The mock redefines `--connector` to a white-alpha value. For *graph edges inside a board* a neutral hairline is fine, but it shouldn't shadow the reserved token name. **Fix:** rename the local var (e.g. `--edge`) or set it to `--border` `rgba(255,255,255,.10)`; don't override the contract token `--connector`.

### Minor — page-area gradient-ish / off-token fills
| Selector | Value | Fix |
|---|---|---|
| `.page-topbar` | `background: rgba(255,255,255,.012)` | Not a token; effectively invisible film. Use `--surface` or drop it (the border already separates). |
| `.sk-row` (skeleton) | `background: rgba(255,255,255,.05)` | Skeleton bars — use `--border` (`rgba(255,255,255,.10)`) or `--surface-raised`; avoid one-off alphas. |
| `.winbtn` | `background: rgba(255,255,255,.12)` | Window dots — `--border-strong` (`rgba(255,255,255,.16)`) or `--text-faint`; `.12` is between tokens. |
| `.pt-logo` | `border: 1px solid rgba(79,140,255,.3)` | Off-token accent alpha. Use `--border` or `--accent-wash`-derived; the `.pt-logo` fill (`--accent-wash`) is fine. |
| `.page-dim` | `rgba(10,10,11,.35)` | This is a dim scrim over the captured page (functional, like the §6 LOD/full-view dim). Acceptable, though `--scrim` is `rgba(0,0,0,.5)`; if you want it on-token, use a lighter `--void`-based alpha. Low priority. |
| `.gnode.entity` border | `rgba(79,140,255,.18)` | Resting entity nodes shouldn't carry an accent-tinted border (accent = active/selected only). **Fix:** `--border` for resting; the `.on` state already adds accent correctly. |

### Minor — accent-tinted pill borders (resting state)
- `.schema-head .ent`, `.lineage-tag`, `.insp-entity-head .ent-pill`, `.schema-head .ent` all use `border: 1px solid rgba(79,140,255,.25)` + `--accent-wash` + `--accent` text at **rest**. Lineage/entity pills are *labels*, not active controls. This is borderline — accent on a lineage tag is arguably "functional" (it marks the inferred-relationship signal). **Disposition:** acceptable IF lineage is the one accent-coded concept in B; but the *entity pill* and *Order[] chip* are just type labels → neutralize those to `--text-3` on `--surface-raised`/`--border-subtle`, and keep accent only on the genuinely-functional `.lineage-tag` + selected path. Don't accent-tint three different pill classes or the accent loses its "this is the active thing" meaning.

### Minor — font-size scale
| Selector | Value | Fix |
|---|---|---|
| `.gn-kind` `9px`, `.gnode .m` `9px`, `.ent-pill`/`.role` `9px`, `.winbtn` etc. | `9px` glyph/micro marks | Acceptable as sub-micro affordances (consistent with the 9px floor used throughout). No fractional sizes present — B is clean on the scale otherwise. `15px` on `.ent-name` = `h` ✓. |

### Pass
- Surfaces, borders, text ramp, radii, `--accent`/`--accent-wash`, the `.sm-2xx/3xx/4xx` status-mix bars (correct status-hue usage — these ARE status), the `.live-dot`/`.footnote i` `--ok` dots (correct), tab `.active::after` 2px accent underline, selected-row `--accent-wash`, and the SVG graph edges (`--accent` for selected path, `--connector` hairline for calls, dashed `--accent` for lineage) are all correct functional usage.

---

## Cross-cutting summary (what to change before screenshot sign-off)

1. **Kill all syntax-type hues** in both mocks (`.v-str/.v-num/.v-bool`, `.t-string/.t-number/.t-bool/.t-id`, and the matching `.badge.*`): values → `--text`/`--text-2`; type chips → `--text-3` + `--border-subtle`. Keys stay `--accent`; links stay `--accent`; literally nothing else gets a value-hue.
2. **De-chromatize HTTP methods** (A: `.m.post`→neutral; B: `.m-get/.m-post/.m-ws` and `.role.*`→neutral text + neutral chrome). Purple (`.m-ws`, `.t-id`, `.v-bool`) is an outright §1.3 ban.
3. **Remove the two glow/ring flourishes:** A's `.seg button.on` inset ring; B's `.gnode.on` double accent ring → canonical single 1.5px accent ring.
4. **Reserve status hues for status only** — they're correctly used on status-code columns and status-mix bars; remove every other green/amber/red usage (method labels, role chips).
5. **Stop overriding the `--connector` token** in B and replace one-off white-alpha fills (`.012/.05/.12/.18/.25/.3`) with the nearest token (`--border-subtle`/`--border`/`--border-strong`/`--accent-wash`).
6. **A only:** snap `11.5px`→`11px`, `10.5px`→`10px`, `8px`→`9px`.

Mock files for the fixes: Mock A is inline-only (no file path given); **Mock B is at `Z:\Canvas ADE\.canvas\tmp\data-flow-view-mock.html`**.