// src/main/hooks/recordSession.js — Claude Code hook (SessionStart + UserPromptSubmit +
// SessionEnd, F2). No deps; runs under the app's node.
// argv[2] = absolute mapping-file path (baked at install). env.CANVAS_RECAP_BOARD = our board id.
'use strict'
const fs = require('node:fs')
try {
  const mapPath = process.argv[2]
  if (!mapPath) process.exit(0)
  // Cross-cwd recap capture: the hook now also lives in repos boards spawn INTO (not only the
  // open project), where the user's ordinary claude sessions run without CANVAS_RECAP_BOARD.
  // Those sessions are not canvas boards — exit before reading stdin instead of appending a
  // boardId:'' line per event forever (readRecapMap drops such lines, but the file would grow).
  if (!process.env.CANVAS_RECAP_BOARD) process.exit(0)
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
  // F2: record whether the transcript ALREADY EXISTS at fire time. SessionStart fires before
  // Claude writes the .jsonl (eager capture — resume research RC-1), so its entries are
  // unconfirmed; a UserPromptSubmit/SessionEnd entry with transcriptExists:true is proof the
  // session became a real, resumable conversation (readRecapMap keeps the latest such entry as
  // `confirmed`). Never assume — always check the file.
  const transcriptPath = d.transcript_path || ''
  let transcriptExists = false
  try {
    transcriptExists = !!transcriptPath && fs.existsSync(transcriptPath)
  } catch {
    transcriptExists = false
  }
  const line = JSON.stringify({
    boardId: process.env.CANVAS_RECAP_BOARD || '',
    sessionId: d.session_id || '',
    transcriptPath,
    cwd: d.cwd || '',
    source: d.source || '',
    hookEvent: d.hook_event_name || '',
    transcriptExists,
    ts: Date.now()
  })
  // Append-only by design: this hook runs in the user's separate `claude` process, so it must not
  // race the app's reads/writes of this file. readRecapMap() is last-write-wins per boardId, so the
  // live map stays bounded no matter how many lines accumulate. Since F2 the file grows ~1 short
  // line (~150 bytes) per PROMPT rather than per session — still low-single-digit MB/year for a
  // heavy user: a re-parse cost, not a correctness issue. Safe compaction would need cross-process
  // locking (the app can't rewrite this file without racing this appender), so it's deliberately
  // skipped; revisit with a real lock if the file ever grows enough to matter.
  fs.appendFileSync(mapPath, line + '\n')
} catch {
  /* never fail the agent's startup */
}
process.exit(0)
