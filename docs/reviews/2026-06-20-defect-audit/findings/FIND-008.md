# FIND-008 — Non atomic writeFileSync in CLI provisioners can corrupt the user config on a crash

| | |
|---|---|
| **Severity** | Medium |
| **Category** | data integrity |
| **Status** | CONFIRMED (independently re-verified) |
| **Primary location** | `src/main/cliProvisioners/shared.ts:188-201` |
| **Discovery slice** | M-MCP-ORCH (run 2) |

## Summary
writeJsonConfig/writeTextConfig write the user's REAL config files (`~/.gemini/settings.json`, `~/.codex/config.toml`, `<project>/.mcp.json`, `<project>/opencode.json`) with a plain `writeFileSync(file, ...)` — NOT write-file-atomic, which the sibling consent store (orchestrationConsent.ts:70) deliberately uses for exactly this class of file. A crash/power-loss mid-write (these run synchronously at every terminal spawn) leaves a truncated/partial file. Because readJsonConfig THROWS on a present-but-corrupt file (shared.ts:167, by design, to avoid clobbering), the user's own CLI config is then both corrupted on disk AND un-reparseable, so every subsequent sync also fails. The app writes into the user's untouched home/project config (merge-not-clobber discipline) but skips the durability half of that discipline.

## Trigger
A terminal spawn (or Sync modal) writes `~/.gemini/settings.json` containing the user's other servers/settings; the process is killed (or crashes) after writeFileSync truncates but before the full buffer is flushed → the user's Gemini config is left half-written and unreadable.

## Evidence / concrete faulty path (code-grounded)
A crash during the truncate then write leaves a partial file and the reader throws on it so the corruption is sticky and blocks every later sync

## Verifier reasoning (why CONFIRMED; scope & severity)
The provisioner write helpers use a plain non atomic writeFileSync on the user real CLI config files while the sibling consent store uses an atomic write for the same class of file

## Fix direction (audit only — NOT applied)
Write provisioner configs with the repo-wide atomic primitive (write-file-atomic, temp+rename) instead of a direct writeFileSync, preserving the 0o600 chmod, so a crash mid-write cannot corrupt the user-owned CLI config (which holds their other MCP servers/settings).

## Files this card touches
- `src/main/cliProvisioners/shared.ts (writeJsonConfig/writeTextConfig 188-201)`

## Collision flags (sequence with)
- cliProvisioners/ → FIND-001
