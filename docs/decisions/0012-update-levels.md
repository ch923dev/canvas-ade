# ADR 0012 — Update levels (optional / recommended / mandatory) + the R2 feed

- **Status:** Accepted (2026-07-06)
- **Extends:** [ADR 0008](0008-packaging-signing-and-auto-update-gate.md) (the packaging + auto-update
  gate) and borrows the compat-floor idea from [ADR 0007](0007-schema-forward-compat.md).
- **Context:** The manual-update model (auto-check on launch; user-driven download + install) shipped,
  but every release was treated identically — a quiet toast the user could ignore. That is wrong for
  two cases we will hit: (a) we ship a **broken build** and need everyone off it, and (b) once the
  SaaS API exists, a client too old to talk to it must be **cut off**. We also needed to decide where
  the feed is hosted now that GitHub Releases (which needs a public repo or a baked token) is a poor
  fit for a closed-source paid product.

## Decision

### Three tiers, driven by a side-channel manifest
electron-updater only answers "is there a newer version". The tier is decided by a **sibling file on
the feed, `updates.json`** (fetched by main, NOT part of electron-updater — see
`src/main/autoUpdate.ts` › `getMeta`):

```json
{ "latest": "0.11.0", "minSupported": "0.9.0", "tiers": { "0.11.0": "recommended" } }
```

- **optional** (default, untagged) → a quiet, dismissable toast. Most releases.
- **recommended** (`tiers[version] === "recommended"`) → a persistent, dismissable **top banner**.
- **mandatory** → a **blocking modal** the user cannot dismiss until they update.

**The floor `minSupported` is the ONLY force trigger:** a running version *strictly below* it is
forced. This is the app-binary analogue of the schema `minReaderVersion` compat floor (ADR 0007) —
same mental model, applied to the client instead of a document. A per-version `"mandatory"` tag was
rejected as redundant: to force everyone onto a fix, raise the floor to the bad-version + 1.

### Fail-open on the force path
If `updates.json` is unreachable or unparseable, `getMeta` resolves null and the flow **never emits
mandatory** — a transient feed blip must not lock a user out of their own app. It degrades to a plain
optional update. The tier likewise defaults to optional. Failing open is deliberate and asymmetric:
the cost of a missed force is bounded; the cost of a false lockout is not.

### Latched surface in the renderer
The tier arrives on the `available`/`mandatory` event; the follow-on `downloading`/`ready`/`error`
events carry none. `UpdateSurfaces.tsx` **latches** the channel so the banner/modal owns the whole
download → restart flow, and a forced latch never downgrades. Exactly one transient surface shows at a
time; Settings ▸ About (`AboutPane`) is the separate always-available surface.

### Feed hosting: Cloudflare R2 (generic provider)
The feed moves off the GitHub provider to **Cloudflare R2** behind `updates.expanse.app`, wired as the
electron-builder **`generic`** provider. Rationale: closed-source-safe (no public repo / baked token),
own domain, and **zero egress fees** — the dominant cost for a 60–150 MB installer as the user base
grows (blockmap differential download already spares repeat users the full payload). The generic
provider is read-only, so **uploads are decoupled**: `scripts/release.mjs` builds with the gate on,
assembles a clean feed dir, generates `updates.json`, and `rclone copy`s it to R2. Because the app
reads via a plain HTTPS `url`, swapping R2 → GCS/S3 later is a one-line `url` change (no lock-in).

## Consequences

- **Security invariant intact.** The tier layer rides entirely on top of the ADR 0008 gate — an
  unsigned build wires no updater, fetches no `updates.json`, and shows no surface. Force is gated the
  same way as any other update.
- **Kill-switch ready before we charge money.** Raising `minSupported` in one JSON file forces the
  fleet off a bad build on next launch — no new binary needed.
- **Local-testable.** `CANVAS_UPDATE_FEED` + a patched `app-update.yml` point both the manifest fetch
  and electron-updater at `http://127.0.0.1:<port>`; publish a higher version + an `updates.json` to
  exercise each tier (runbook: `docs/contributing/releasing.md` › Update levels).
- **Cost:** one more published file per release (`updates.json`) and a hand-edited `build/updates.json`
  when a release needs a non-default tier or a floor bump. Accepted — it is the whole control surface.
