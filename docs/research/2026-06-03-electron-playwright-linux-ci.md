# Electron + Playwright `_electron` on headless Linux CI — research

**Date:** 2026-06-03 · **For:** T5 (re-enable the e2e CI gate, Win+Linux matrix) ·
**Method:** deep-research (5 angles → 17 sources → 57 claims → 25 adversarially verified, 19 confirmed / 6 killed)
**Feeds:** `docs/superpowers/specs/2026-06-03-testing-t5-ci-gate-design.md`

## Why

T5 adds an `ubuntu-latest` e2e leg to prove the *nix process-tree-kill (negative-pgid) path for real
and broaden native-surface coverage. Linux-on-CI for Electron is the fragile part — this grounds the
launch config in verified facts so the spike (T5a) only has to resolve the one genuinely-open unknown
(capturePage/GL).

## Confirmed (high confidence)

1. **Xvfb is required.** Electron is Chromium-based and "will fail to launch" with no display driver
   on a headless runner. Prefix the test command with `xvfb-run -a` (`--auto-servernum`, avoids
   display-number collisions). Apply **only on Ubuntu** (Windows/macOS runners don't need it).
   - **Do NOT assume `ubuntu-latest` ships Xvfb** — that claim was contested (1-2). Install it
     explicitly: `sudo apt-get update && sudo apt-get install -y xvfb`.
   - Sources: Playwright CI docs, Electron "testing-on-headless-ci" docs, Playwright #11932 / #34251.

2. **Sandboxed Electron fails to launch on CI Linux → pass `--no-sandbox` to the TEST launch.**
   On unprivileged headless Linux CI the SUID `chrome-sandbox` helper is not correctly configured
   (Electron #42510: *"The SUID sandbox helper binary was found, but is not configured correctly.
   Rather than run without sandboxing I'm aborting now"*); Ubuntu 24.04 also restricts unprivileged
   user namespaces via AppArmor. Symptom: abort or `electron.launch: Timeout 30000ms exceeded`
   (Playwright #16814) — **only in CI, fine locally**.
   - **Constraint-compatible fix:** `_electron.launch({ args: ['--no-sandbox'] })` — a **launch-time
     flag on the TEST instance**, NOT a change to the app's `webPreferences.sandbox:true`.
   - **Refuted (0-3):** disabling `app.enableSandbox()` in app code when `isCI`. Don't change app code;
     pass the flag to the launcher. This is exactly our locked constraint, and the evidence endorses it.
   - Sources: Electron #42510, Playwright #16814 / #12139 / #34251.

3. **node-pty must be rebuilt against the Electron ABI** (Electron uses Chromium's BoringSSL ABI, not
   system-Node's; Electron 33 ≈ Node ABI 130). `@electron/rebuild` **auto-detects** the installed
   Electron version and downloads the right headers. Skipping this on Linux → "PTY unavailable".
   - **Our repo already covers this:** `postinstall` = `electron-builder install-app-deps` rebuilds
     node-pty for Electron on every `pnpm install`, all OSes. No extra CI step needed.
   - **Refuted (0-3):** forcing the ABI via `--force-abi` — auto-detect is the supported path; don't
     hardcode an ABI number.
   - Sources: Electron "using-native-node-modules" docs, electron/rebuild README, emdash PR #1069.

4. **Flake mitigation: `workers: 1` + CI retries.** Official Playwright recommendation is
   `workers: process.env.CI ? 1 : undefined` (each test gets full resources) and `retries` (off by
   default). Playwright classifies fail-then-pass as **"flaky"** (distinct from "failed"), surfacing
   capturePage/launch flakiness rather than hard-failing. We already run `workers: 1`; add
   `retries: process.env.CI ? 2 : 0`.
   - Sources: Playwright CI docs, Playwright test-retries docs.

## UNRESOLVED — spike empirically (T5a)

**capturePage on headless Linux + which GL flag.** No surviving verified claim establishes whether
`BrowserWindow.capturePage()` / a native child `WebContentsView` returns a **non-blank** frame under
headless Xvfb (no GPU) on Electron 33, nor which exact flag works (`--use-gl=swiftshader` vs
`--use-angle=swiftshader` vs `--use-gl=angle`). The one blank-frame issue (Electron #11425) was
contested 1-2. **Treat software-GL as a likely-but-unverified mitigation; validate on a real
`ubuntu-latest` run.** This is the single reason T5a (the throwaway spike) exists.

Likely-also-needed on contended Linux runners (standard Chromium-on-CI flags, validate in the spike):
`--disable-dev-shm-usage` (small `/dev/shm` on runners), possibly `--disable-gpu`.

## Net launch-args recipe (CI + Linux gated, applied in `e2e/fixtures.ts`)

```
const ci = !!process.env.CI
const linux = process.platform === 'linux'
const args = ['out/main/index.js']
if (ci && linux) args.push('--no-sandbox', '--disable-dev-shm-usage')
// GL flag added here IFF the T5a spike shows blank capturePage:
//   args.push('--use-gl=swiftshader')  // or --use-angle=swiftshader — spike decides
```

`--no-sandbox` / `--disable-dev-shm-usage` are **confirmed-needed** and go in from the start. The GL
flag is **spike-gated**. None of these touch `webPreferences`; the app sandbox is untouched.

## Workflow recipe (both smoke jobs, matrix)

```yaml
strategy: { fail-fast: false, matrix: { os: [windows-latest, ubuntu-latest] } }
runs-on: ${{ matrix.os }}
needs: check
steps:
  - checkout / setup-node@22 / setup-python@3.11 / corepack enable
  - pnpm install --frozen-lockfile        # postinstall rebuilds node-pty for Electron (all OSes)
  - if runner.os == 'Linux': sudo apt-get update && sudo apt-get install -y xvfb
  - if runner.os == 'Linux':   xvfb-run -a pnpm test:e2e
  - if runner.os == 'Windows': pnpm test:e2e
  - upload-artifact playwright-report/ if: failure()
```

No `playwright install` (`_electron` uses the `node_modules` Electron, not a downloaded browser).
No separate `pnpm build` (`pretest:e2e` = `electron-vite build`).

## Caveats / residual open questions

- capturePage/GL — unresolved, spike it (above).
- `ubuntu-latest` Xvfb-preinstalled — contested; install explicitly, don't assume.
- Whether `--no-sandbox` alone fully clears the Electron-33 ubuntu launch, or also needs
  `--disable-gpu` — confirm in the spike.
- Linux node-pty signal/pgid runtime vs Windows beyond the ABI rebuild — the `processTree.e2e.ts`
  real-tree test validates the negative-pgid reap directly.

Sources (primary): playwright.dev/docs/ci · playwright.dev/docs/test-retries ·
electronjs.org using-native-node-modules · electronjs.org testing-on-headless-ci · electron/rebuild.
Forum corroboration: electron #42510 · playwright #16814 / #11932 / #34251 / #12139 · emdash #1069.
