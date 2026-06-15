/**
 * Schema version constants — kept in a DEPENDENCY-FREE module so any consumer (renderer OR a
 * main-side lock-step test) can import the authoritative numbers WITHOUT dragging in the rest of
 * boardSchema's module graph (which transitively imports DOM-only code via terminalFont, breaking
 * the node tsconfig). `boardSchema.ts` re-exports these; MAIN's `projectStore.ts` hand-mirrors them
 * (a renderer→main import is avoided in shipped code) and a lock-step test asserts parity (BUG-013/014).
 *
 * Bump on any breaking change to the persisted shape and add a migration in `boardSchema.ts`.
 *
 * SCHEMA-VERSION CLAIM:
 * - v5 = MCP M2 — spatial connectors.
 * - v6 = board groups (named board clusters, #84). Backfills an empty `groups` array.
 * - v7 = free-text typography tokens (fontFamily / fontSize / align / color / bold — all optional on
 *   TextElement; defaulted at render time). Identity migration. #84 took v6 first, so v6 → v7 (ADR 0004).
 * - v8 = optional TextElement.width (area-text wrap-box width in board px). All-optional → identity bump.
 * - v9 = optional root `background` (canvas backdrop). Optional + defaulted-at-read → identity bump.
 * - v10 = optional TerminalBoard `agentKind` + `monitorActivity` (New Terminal agent presets). Both
 *   optional + defaulted-at-read → identity bump; ADDITIVE so MIN_READER_VERSION stays 9.
 * - v11 = the Planning `diagram` element kind (S4 — Mermaid Diagram). A NEW element kind is
 *   BREAKING per ADR 0007: a pre-11 validator's `assertPlanningElement` default branch throws on
 *   the unknown kind, so the compat floor moves to 11 too (see MIN_READER_VERSION below). The
 *   migration itself is identity (the kind only appears on newly-authored diagram elements).
 *   Do not silently reuse a version for a new shape.
 */
export const SCHEMA_VERSION = 11

/**
 * Two-tier versioning (ADR 0007): the compat floor stamped into every written doc as
 * `minReaderVersion` — the lowest SCHEMA_VERSION an app needs to read what we write.
 *
 * - ADDITIVE change (new OPTIONAL fields, defaulted at read): bump SCHEMA_VERSION only.
 *   Older readers (>= this floor) still open the doc; unknown optional fields ride through
 *   fromObject's structuredClone and survive a save round-trip.
 * - BREAKING change (new board type / element kind, a semantic change an older validator rejects or
 *   misreads, or a NEW DOC-LEVEL KEY — toObject rebuilds the root object, so an older reader's save
 *   would DROP it): bump BOTH to the same value.
 *
 * Floor was 9 (v9's root `background` key — a v8 reader would DROP the user's wallpaper on its next
 * save). Floor moves to 11 with the v11 `diagram` element kind (S4): an app older than 11 has no
 * `diagram` case in `assertPlanningElement`, so it would HARD-FAIL deep validation on a doc that
 * contains one. Stamping `minReaderVersion: 11` makes pre-11 apps show the clean "update the app to
 * open it" message (assertReadableVersion) instead of a confusing `.bak`-fallback parse failure.
 * Every app from 11 on can read all future additive docs.
 */
export const MIN_READER_VERSION = 11
