// src/main/hooks/recordSession.js — Claude SessionStart hook. No deps; runs under the app's node.
// argv[2] = absolute mapping-file path (baked at install). env.CANVAS_RECAP_BOARD = our board id.
'use strict'
const fs = require('node:fs')
try {
  const mapPath = process.argv[2]
  if (!mapPath) process.exit(0)
  let stdin = ''
  try {
    stdin = fs.readFileSync(0, 'utf8')
  } catch {
    stdin = ''
  }
  let d = {}
  try {
    d = JSON.parse(stdin)
  } catch {
    d = {}
  }
  const line = JSON.stringify({
    boardId: process.env.CANVAS_RECAP_BOARD || '',
    sessionId: d.session_id || '',
    transcriptPath: d.transcript_path || '',
    cwd: d.cwd || '',
    source: d.source || '',
    ts: Date.now()
  })
  // Append-only by design: this hook runs in the user's separate `claude` process, so it must not
  // race the app's reads/writes of this file. readRecapMap() is last-write-wins per boardId, so the
  // live map stays bounded no matter how many lines accumulate. The file itself grows ~1 short line
  // (~100 bytes) per session: a few hundred KB/year even for a heavy user, low-single-digit MB over
  // years — a re-parse cost, not a correctness issue. Safe compaction would need cross-process
  // locking (the app can't rewrite this file without racing this appender), so it's deliberately
  // skipped; revisit with a real lock if the file ever grows enough to matter.
  fs.appendFileSync(mapPath, line + '\n')
} catch {
  /* never fail the agent's startup */
}
process.exit(0)
