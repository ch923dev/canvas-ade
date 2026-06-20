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
| `production.yml` | a **GitHub Release is published** | `check` → full matrix package → **sign + notarize (if secrets present)** → upload assets + `latest.yml` to the Release. | Yes, when secrets exist |

The matrix is win + mac + linux × x64/arm64 (one native job per OS/arch where the toolchain
can't cross-compile native modules). node-pty is rebuilt against the Electron ABI per job.

## Cutting a release

1. **Bump the version** in `package.json` (semver; auto-update compares versions, so it must
   increase monotonically). Commit on a branch and merge via the normal gate.
2. **Tag + publish a GitHub Release** for that version (e.g. `v0.2.0`). Publishing the Release
   fires `production.yml`, which builds the full matrix and uploads the installers + `latest.yml`
   to that Release.
3. If signing secrets are configured (below), the uploaded assets are signed/notarized and
   `latest.yml` (the electron-updater feed manifest) points at them.

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
