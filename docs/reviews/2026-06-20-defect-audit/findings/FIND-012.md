# FIND-012 — recap:setConsent persists consent before installing the SessionStart hook with no try/catch — an I/O throw from installRecapHook leaves consent 'enabled' but the hook uninstalled for the rest of the session (self-heals on next project open/restart)

| | |
|---|---|
| **Severity** | Low |
| **Category** | error-handling · consent integrity |
| **Status** | CONFIRMED (independently re-verified) |
| **Primary location** | `src/main/recapConsent.ts:82-84` |
| **Discovery slice** | M-RECAP-MISC (run 1) |

## Summary
recap:setConsent writes the consent decision to disk (writeConsent, line 82) BEFORE invoking onDecision (line 83), which installs/removes the Claude SessionStart hook. onDecision (index.ts:567) calls installRecapHook/removeRecapHook with no try/catch, and installRecapHook→writeSettings (agentRecapMap.ts:51-54) can throw on a real I/O error (EACCES/ENOSPC writing <projectDir>/.claude/settings.local.json). If it throws, the throw escapes the ipcMain.handle callback (renderer's invoke rejects), but consent is ALREADY persisted as 'enabled' on disk. Result: a durable desync — getConsent reads 'enabled' so the egress gate opens, yet the SessionStart hook was never installed, so no transcript is ever recorded and the recap silently never works, with no retry path (a later setConsent('enabled') is a no-op since the value is unchanged). This is the same desync class the BUG-032 comment in agentRecapMap.ts:136-141 guards for removeRecapHook's malformed-array TypeError, but the general I/O-throw case is unguarded on BOTH the enable and decline sides. Fails toward the SAFE direction for egress (gate open but no hook = nothing to egress), so severity is Low.

## Trigger
User clicks 'Enable recaps'; the OS denies/fails the write to <projectDir>/.claude/settings.local.json (read-only dir, ENOSPC, or a directory-permission error in mkdirSync). writeConsent has already persisted 'enabled'; installRecapHook then throws; the consent store and the actual hook state are now permanently out of sync.

## Evidence / concrete faulty path (code-grounded)
Faulty path: recapConsent.ts:82 writeConsent(userDataDir, dir, 'enabled') persists to <userDataDir>/recap-consent.json (succeeds); line 83 onDecision(dir, 'enabled') → index.ts:569 installRecapHook(...) → agentRecapMap.ts:51-53 writeSettings does mkdirSync(<projectDir>/.claude) + writeFileAtomic.sync(<projectDir>/.claude/settings.local.json) which throws on EACCES/ENOSPC (read-only or full project folder). recap:setConsent handler (recapConsent.ts:78-85) has no try/catch, so the throw escapes ipcMain.handle and the renderer invoke rejects — but consent is already 'enabled' on disk while no SessionStart hook exists. Mitigation that bounds it to non-permanent: index.ts:524-531 re-runs installRecapHook whenever readConsent===' enabled' on project open, fired via projectIpc.ts:254 (project:open) and projectIpc.ts:404 (project:current auto-reopen at startup), both wrapped best-effort. installRecapHook is idempotent (agentRecapMap.ts:74 early-returns if installed). Untested: recapConsent.test.ts:72-73 onDecision stub only pushes to an array and never throws, so the throw-from-onDecision path is uncovered.

## Verifier reasoning (why CONFIRMED; scope & severity)
The mechanical claims are all accurate against the real code. recapConsent.ts:82-83 persists the decision (writeConsent → <userDataDir>/recap-consent.json) BEFORE invoking onDecision, and the recap:setConsent handler (lines 78-85) has NO try/catch (unlike the orchestration handler, whose own comment at index.ts:624 notes "the IPC handler also wraps this in try/catch"). onDecision wires straight to installRecapHook (index.ts:567-575) with no guard, and installRecapHook→writeSettings (agentRecapMap.ts:51-54) does mkdirSync + writeFileAtomic.sync to a DIFFERENT location (<projectDir>/.claude/settings.local.json) — both throwable on EACCES/ENOSPC on a read-only/full project folder while the userData write succeeds. So a concrete faulty path exists: click Enable → consent written 'enabled' → installRecapHook throws → invoke rejects → for the rest of the session getConsent reads 'enabled' (egress gate logically open) yet the SessionStart hook is absent, so no transcript is ever recorded.

However the candidate OVERSTATES impact in two ways. (1) "Permanent / no retry path" is refuted: the self-heal path at index.ts:516-533 re-runs installRecapHook (idempotent) for any 'enabled' project on EVERY project open AND auto-reopen — wired through projectIpc.ts:252-257 (project:open) and :401-407 (project:current, the startup auto-reopen), both best-effort try/catch. A transient I/O failure self-corrects on the next open/restart; the desync window is only the current session and only for a genuinely persistent failure. (2) It fails toward the SAFE direction for the security-critical concern: gate open but no hook means nothing is ever recorded, so there is nothing to egress (the candidate concedes this). The same desync class is already a known, partially-guarded area (BUG-032 comment, agentRecapMap.ts:136-141). Real but minor robustness gap; Low severity stands, in scope as an error-handling defect (not perf/a11y/styling/UX).

## Fix direction (audit only — NOT applied)
Install the SessionStart hook before (or atomically with) persisting consent, wrapped in try/catch; on a hook-install I/O failure, surface the error and do not leave consent persisted as enabled-without-hook for the session.

## Files this card touches
- `src/main/recapConsent.ts (82-84)`
- `src/main/recapIpc.ts (recap:setConsent handler)`

## Collision flags (sequence with)
- None — independently fixable in parallel.
