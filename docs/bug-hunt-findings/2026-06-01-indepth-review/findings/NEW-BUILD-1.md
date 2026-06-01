# NEW-BUILD-1: electron-updater declared as a runtime dependency but autoUpdater is never initialized

- **Severity:** Info
- **Category:** build/config
- **Status:** CONFIRMED
- **Files touched:** `package.json`, `src/main/index.ts`, `electron-builder.yml`
- **Assigned:** _(blank)_

## Summary

`electron-updater` is listed in `package.json` `"dependencies"` (not `devDependencies`), meaning it is packed into every release build's `node_modules`. However, `autoUpdater` from that package is never imported or called anywhere in the source tree. When Phase 5 wires up the `publish:` feed in `electron-builder.yml`, the packaged app will silently never check for or download updates — because no code calls `autoUpdater.checkForUpdatesAndNotify()` (or equivalent). The module is inert dead weight in every build until that integration is added.

## Where

- `package.json` line 41: `"electron-updater": "^6.3.4"` in `"dependencies"`
- `src/main/index.ts`: no `import` of `electron-updater` anywhere (full-file scan confirmed)
- `electron-builder.yml` line 48: `publish: null` (placeholder comment: "auto-update feed is configured in Phase 5")

## How it triggers

The issue does not cause a runtime crash today because `publish: null` means electron-builder never generates an update feed. The defect becomes active the moment Phase 5 sets a real `publish:` provider: the packaged app will query no update server and deliver no update to users, because `autoUpdater` is never started. This is a silent failure — no error, no log, just no updates ever delivered.

Additionally, the package adds ~2 MB of pure-JS code to every packaged build across all platforms without contributing any runtime behaviour.

## Verification evidence

Exhaustive search across all `.ts` source files and the compiled `out/` tree:

```
grep -rn "autoUpdater\|electron-updater" src/ --include="*.ts"
# → zero matches
```

`package.json` line 41 confirms the dep is in `"dependencies"` (runtime, not dev-only):
```json
"electron-updater": "^6.3.4",
```

`electron-builder.yml` line 47-48:
```yaml
# auto-update feed is configured in Phase 5; placeholder generic provider.
publish: null
```

The `pnpm-lock.yaml` shows `electron-updater@6.8.3` is resolved and installed. `electron-builder install-app-deps` (the `postinstall` script) includes it in the packaged `node_modules`.

## Suggested fix direction

This is intentionally deferred to Phase 5 per the roadmap comment. When Phase 5 arrives, add an `autoUpdater` initialization block to `src/main/index.ts` (e.g. inside `app.whenReady()`, after `createWindow()`, gated on `!is.dev && !SMOKE`), and replace `publish: null` with the real provider config. Until then no action is required — but the Phase 5 implementation must remember to wire both sides (the `publish:` config AND the `autoUpdater` call); adding only the feed config will not deliver updates.

## Collision notes: TBD (computed in INDEX)
