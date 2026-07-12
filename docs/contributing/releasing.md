# Releasing (Phase 5 — packaging, signing, auto-update)

How Canvas ADE is packaged, signed, and shipped. The packaging pipeline is **release-ready
now and unsigned**: every piece (icons, entitlements, update feed, the auto-update code path,
and CI signing steps) is wired so that turning on signed + auto-updating releases is a matter
of **adding secrets** — no code or workflow edits. See ADR
[`0008-packaging-signing-and-auto-update-gate`](../decisions/0008-packaging-signing-and-auto-update-gate.md)
for the decision record.

## The pipeline at a glance

| Workflow | Trigger | What it does | Signed? |
|---|---|---|---|
| `pr.yml` | PR | `check` only (typecheck · lint · format · unit + SCA audit). No packaging. | — |
| `staging.yml` | push to `main` | `check` → full matrix package → **unsigned** Actions artifacts (7-day). | No (by design) |
| `production.yml` | a **GitHub Release is published** | `check` → full matrix package → **sign + notarize (if secrets present)** → emit the signed installers + `latest*.yml` + `*.blockmap` as **workflow artifacts** (`feed-<os>`). It does **not** upload to the Release — the feed provider is `generic`/R2 (read-only), so the R2 publish is a separate step. | Yes, when secrets exist |

The matrix is win + mac + linux × x64/arm64 (one native job per OS/arch where the toolchain
can't cross-compile native modules). node-pty is rebuilt against the Electron ABI per job.

## Cutting a release

1. **Bump the version** in `package.json` (semver; auto-update compares versions, so it must
   increase monotonically). Commit on a branch and merge via the normal gate.
2. **Tag + publish a GitHub Release** for that version (e.g. `v0.2.0`). Publishing the Release
   fires `production.yml`, which builds + signs the full matrix and emits the signed installers +
   `latest*.yml` + `*.blockmap` as per-OS **workflow artifacts** (`feed-<os>`). It does **not**
   upload to the Release — the feed's electron-builder `publish` provider is `generic` (R2), which
   is read-only (see `electron-builder.yml`).
3. **Publish the feed to R2.** The signed artifacts from step 2 are the feed's payload: assemble
   them into `release/feed/` (installers + `*.blockmap` + `latest*.yml`), add `updates.json`
   (`pnpm feed:gen`), and `rclone copy` to the R2 bucket — the mechanics `scripts/release.mjs`
   automates for a local build (`pnpm release:win|mac|linux`, `R2_REMOTE=…` to actually upload; see
   *Update levels + the R2 feed* below). electron-updater then reads `latest*.yml` + `updates.json`
   over the HTTPS feed. If signing secrets are configured (below), those artifacts are
   signed/notarized. **Follow-up:** wiring the R2 `rclone` upload directly into `production.yml`
   (R2 credentials as secrets) is not yet done — today the feed publish from the CI artifacts is a
   manual step.

Local one-offs (no publish): `pnpm build:win | build:mac | build:linux`, or `pnpm pack:dir`
for a fast unpacked `release/win-unpacked/` (no installer). These never upload.

## Code signing (add secrets to go from unsigned → signed)

electron-builder reads these from the environment; `production.yml` already passes each from a
repo **secret** (or **variable**). When a secret is unset the build degrades gracefully to
unsigned, so the pipeline keeps working before any certs exist.

### macOS — Developer ID + notarization

Requires an Apple Developer Program membership (~$99/yr).

| Secret | Value |
|---|---|
| `CSC_LINK` | base64 of your **Developer ID Application** `.p12`: `base64 -i cert.p12 \| pbcopy` |
| `CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_ID` | your Apple ID email (notarization) |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | your 10-char Apple Team ID |

Hardened runtime + entitlements (`build/entitlements.mac.plist` / `*.inherit.plist`) are already
configured (`electron-builder.yml` › `mac`). Notarization runs automatically once the `APPLE_*`
env is present and the app is signed.

### Windows — Authenticode

| Secret | Value |
|---|---|
| `WIN_CSC_LINK` | base64 of your code-signing `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | the `.pfx` password |

> ⚠️ Since June 2023, OV/EV certificates must live on a **hardware token or cloud HSM** — a
> portable `.pfx` is only possible for older/IV certs. For a modern cert use a **cloud signer**
> (e.g. **Azure Trusted Signing** ~$10/mo, SSL.com eSigner, DigiCert KeyLocker): configure its
> provider in `electron-builder.yml` › `win` (e.g. `azureSignOptions`) and add that provider's
> secrets instead of `WIN_CSC_*`. Leave `WIN_CSC_*` unset in that case.

## Enabling auto-update (do this LAST, after signing is verified)

Auto-update stays **dormant** until you deliberately enable it — this enforces the security
invariant that an **unsigned** app must never pull an update over a feed (a remote-code-execution
vector). The mechanism:

- `electron-builder.yml` › `publish` configures the **GitHub** update feed (this also fixes the
  old `publish: null` bug where `--publish always` uploaded nothing) and bakes `app-update.yml`
  into the app.
- The actual `autoUpdater.checkForUpdates` call (`src/main/autoUpdate.ts`) is fenced behind the
  build-time constant `__ENABLE_AUTO_UPDATE__` (`electron.vite.config.ts` `define`). It is `true`
  only when the build sets `ENABLE_AUTO_UPDATE=1`. In an unsigned build the constant is `false`
  and esbuild **strips the entire updater path out of the bundle** (verified: no `electron-updater`
  reference remains).
- `production.yml` sets `ENABLE_AUTO_UPDATE` from the repo **variable** `AUTO_UPDATE`:

  **To turn on signed auto-updating releases:** after confirming signing works, set repo variable
  `AUTO_UPDATE = 1` (Settings → Secrets and variables → Actions → Variables). The next published
  Release builds with auto-update active; the app checks the GitHub feed on launch, auto-downloads,
  and shows an "Update ready — Restart" toast (reuses the shared toast channel).

## Icons

`build/icon.png` (1024×1024 RGBA) is the **brand source of truth** — the Expanse "Vanishing Point"
mark (accent `#4f8cff` diamond at a vanishing point, on the `#0d0d0f` surface), authored directly,
full-bleed. The Linux AppImage uses it as-is; the Windows and macOS builds use **derived variants**:

| File | Platform | What it is | Wired |
|---|---|---|---|
| `build/icon.png` | Linux | full-bleed source mark | default |
| `build/icon.ico` | Windows | multi-size `.ico` — detailed mark at 256/128/64, a **bold simplified** variant (filled diamond + horizon) at 48/32/16 so the taskbar icon stays legible (the thin perspective lines vanish below ~64px) | `win.icon` |
| `build/icon-mac.png` | macOS | mark inset to Apple's 824/1024 app-icon grid (~100px margin) so the Dock icon is native-sized | `mac.icon` |

Both variants are **derived from `build/icon.png`** — regenerate after any brand-mark change:

```
npx playwright install chromium   # one-time, if missing
node scripts/gen-icon-win.mjs      # build/icon.png → build/icon.ico (multi-size, bold small frames)
node scripts/gen-icon-mac.mjs      # build/icon.png → build/icon-mac.png (padded for macOS)
```

> `build/icon.png` is authored directly (it is NOT script-generated — the old
> `scripts/gen-icon.mjs`, which rendered the legacy Canvas-ADE outline-diamond, was removed). To
> change the brand mark, edit `build/icon.png`, then re-run the two generators above.

## Notes carried into packaging

- **Recap hook (BUG-003):** `recordSession.js` is `asarUnpack`ed and `main` rewrites its path to
  `app.asar.unpacked` + bakes `ELECTRON_RUN_AS_NODE=1`. Verified present in a real package; the
  end-to-end packaged-run confirmation is a manual desktop check (see
  [`../testing/MANUAL-CHECKS.md`](../testing/MANUAL-CHECKS.md) › Packaged build).
- **`hideAttribution`** is set on the React Flow canvas, so no badge ships in the packaged build.
- **node-pty** native binary is unpacked (`**/*.node`, `node_modules/node-pty/**`); on Windows the
  source build needs the MSVC Spectre-mitigated libs (see `CLAUDE.md` › Stack).

## Packaging dependency pins (do not remove)

`package.json` carries two dependencies — **`ajv`** and **`signal-exit`** — that **no app code imports**.
They exist solely to make the **packaged** build correct, and removing them as "unused" reintroduces a
crash that only manifests in a packaged `.exe`/`.app` (never in `pnpm dev` or the unpacked e2e). A
`"//packaging-pins"` key in `package.json` says the same thing inline.

**Why:** electron-builder's pnpm dependency collector only walks **depth-1** from each package
([electron-builder #6289](https://github.com/electron-userland/electron-builder/issues/6289)), so it
misses pnpm's **nested transitive versions**. The production closure needs `signal-exit@4` (pulled by
`write-file-atomic@8`) and `ajv@8` (pulled by `@expanse-ade/mcp` → MCP SDK), but **devDependencies hoist
the incompatible `signal-exit@3` / `ajv@6` to the node_modules root**, so electron-builder packs the
**wrong** versions. Symptoms in the packaged app: `Error: Cannot find module 'signal-exit'`
(`MODULE_NOT_FOUND`) before the window opens, and — if a stale v3 is packed — `onExit is not a function`
on the first project save.

**The fix:** declaring `ajv@^8` and `signal-exit@^4` as **direct dependencies** forces pnpm to place
those versions at the node_modules **root** (direct deps always take the root slot); the dev-only
`ajv@6`/`signal-exit@3` are then nested under their specific consumers (which still resolve them
correctly). electron-builder now collects the right versions at depth-1. Verify after any dependency
change: `node -e "console.log(require('./node_modules/signal-exit/package.json').version,
require('./node_modules/ajv/package.json').version)"` must print `4.x 8.x`. Also requires
**electron-builder ≥ 26.15.5** (the older 26.8.x mis-handles pnpm dedup; fix commit `b348df0`).

**Acceptance test (the only way to catch this class):** `pnpm pack:dir` → launch
`release/win-unpacked/Expanse.exe` → window titled **"Expanse"** (not "Error") → create/open a project
and confirm an autosave succeeds. The e2e suite runs the **unpacked** build and cannot catch a
packaged-only fault. If a future dep adds another prod-vs-dev version split, electron-builder prints
`dependency not found on disk: [...]` during `pack:dir` — pin each listed package the same way.

---

## Update levels + the R2 feed (ADR 0012)

Auto-update ships **three tiers** — **optional** (quiet toast), **recommended** (top banner),
**mandatory** (blocking modal). The tier is set by a side-channel `updates.json` on the feed, next to
`latest.yml`. electron-updater serves the version; `updates.json` decides how loud we get. All of this
still rides on the ADR 0008 gate — an unsigned build wires no updater and shows nothing.

### The tier manifest (`updates.json`)

Source of truth: **`build/updates.json`** (committed). `scripts/gen-updates-json.mjs` stamps `latest`
from `package.json`, validates the semver keys, and writes the published copy:

```jsonc
// build/updates.json
{
  "minSupported": "0.9.0",              // running version < this  → FORCED (blocking modal)
  "tiers": { "0.11.0": "recommended" }  // this version            → banner. absent → optional
}
```

- **To force the fleet off a bad build:** raise `minSupported` to the bad-version + 1. Anyone below is
  forced on next launch; anyone at/above is untouched. This is the kill-switch — no new binary needed,
  just re-publish `updates.json`.
- **To make a release louder (not blocking):** add `"x.y.z": "recommended"`.
- **Fail-open:** if `updates.json` is unreachable, the app **never forces** and defaults to optional —
  a feed blip can't lock anyone out.

### Feed hosting — Cloudflare R2 (one-time setup)

1. Cloudflare → **R2** → create bucket `expanse-updates`.
2. Bucket → **Settings → Public access → Custom domain** → `updates.expanse.app` (point DNS at it).
   `electron-builder.yml` `publish.url` already targets `https://updates.expanse.app/`.
3. Create an **R2 API token** (S3-compatible). Configure an `rclone` remote once per release machine:
   `rclone config` → new remote, type **s3**, provider **Cloudflare**, endpoint
   `https://<accountid>.r2.cloudflarestorage.com`, key/secret from the token. Name it `r2`.

> Swapping R2 → GCS/S3 later is a one-line `publish.url` change (the app reads a plain HTTPS URL).

### Cutting a release

```
pnpm release:win        # builds with the gate ON, packages --publish never, stages release/feed/,
                        # generates updates.json — then PRINTS the upload command (nothing uploads)
R2_REMOTE=r2:expanse-updates pnpm release:win   # …and actually rclone-copies release/feed/ to R2
```

`release/feed/` holds exactly the served files: `latest*.yml` + installer(s) + `*.blockmap` +
`updates.json`. mac/linux legs: `pnpm release:mac` / `pnpm release:linux` (built in CI for the full
matrix; signing is orthogonal — the production workflow signs).

### Local end-to-end test (no certs, no cloud)

Prove the whole flow — including force — on `127.0.0.1`:

1. Serve a feed dir locally: `npx http-server ./local-feed -a 127.0.0.1 -p 8090`. Put a **higher**
   version's `latest.yml` + installer + `.blockmap` + an `updates.json` in it.
2. Build the app with the gate on (`ENABLE_AUTO_UPDATE=1`) and install it.
3. Patch the installed `…/resources/app-update.yml` → `provider: generic`, `url: http://127.0.0.1:8090/`.
4. Launch with `CANVAS_UPDATE_FEED=http://127.0.0.1:8090` so `getMeta` hits the same origin, e.g.
   `set CANVAS_UPDATE_FEED=http://127.0.0.1:8090 && "…\Expanse.exe"`.
5. Exercise each tier by editing the served `updates.json`:
   - `tiers: {}` → **optional** toast · `tiers: {"<latest>":"recommended"}` → **banner** ·
     `minSupported` above the installed version → **blocking modal**.

Use **`127.0.0.1`, not `localhost`** — `localhost` resolves to IPv6 `::1`, and http-server binds IPv4
only (a "couldn't reach the server" red herring). Fully quit every `Expanse.exe` between runs (the
single-instance lock re-focuses the old process and won't re-read the patched config).

---

## Local update channel (maintainer-only, dev-only)

A personal update channel so the maintainer's own installed Expanse updates **in-app from a
loopback feed** — build → publish locally → toast → Download → Restart, no manual
close-and-reinstall. It productizes the local test above, with a hard security fence.

### Security posture (extends ADR 0008, binary-level)

- **Compile-gated:** the userData feed-override path exists ONLY when the build sets
  `LOCAL_UPDATE_CHANNEL=1` (`__LOCAL_UPDATE_CHANNEL__`, `electron.vite.config.ts`) — which only
  `scripts/release-local.mjs` does. pr/staging/production builds dead-code-eliminate it: a
  distributed binary can never be steered by a dropped config file.
- **Loopback-literal only:** the override URL must name `127.0.0.1` or `[::1]` verbatim
  (`localhost` rejected — DNS name). Non-loopback/invalid → production feed (fail-closed).
  Full posture: `src/main/localUpdateFeed.ts`.
- **No upload path:** `release-local.mjs` cannot reach the production feed. Real releases go
  through `scripts/release.mjs` / `production.yml` only.
- **Never forces:** the local `updates.json` is written with no `minSupported` floor.

### One-time bootstrap

1. Write the override into the **packaged** app's userData (survives every update install —
   unlike `resources/app-update.yml`, which each install rewrites). The packaged app's
   userData is named after `productName`, NOT the package name (`canvas-ade` is dev-only):
   ```
   %APPDATA%\Expanse\update-feed.local.json   →   { "url": "http://127.0.0.1:8090/" }
   ```
2. `node scripts/release-local.mjs` — builds with both gates on, stamps
   `X.Y.(Z+1)-local.N`, stages `C:\expanse\local-feed\`, starts/verifies the loopback server
   (`scripts/serve-local-feed.mjs`, binds 127.0.0.1 only).
3. Install that first build manually (`C:\expanse\local-build\Expanse-…-local.1-x64.exe`) —
   the **last** manual install. Every later `release-local` run is offered in-app.

### Versioning

`package.json` `X.Y.Z` → stamp `X.Y.(Z+1)-local.N` via `--config.extraMetadata.version`
(`package.json` never edited). Always above the repo version, always **below** the next real
patch release — a future signed `X.Y.(Z+1)` supersedes every `-local.N` build. Delete the
userData override file to return the install to the production feed.

### Signing interplay (later)

Once real releases are signed (Azure Trusted Signing), a signed installed app + unsigned
local updates need a decision: sign local builds too, or keep `publisherName` out of the
local feed config so electron-updater skips the publisher check. Revisit when certs land.
