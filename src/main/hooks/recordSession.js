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
  fs.appendFileSync(mapPath, line + '\n')
} catch {
  /* never fail the agent's startup */
}
process.exit(0)
