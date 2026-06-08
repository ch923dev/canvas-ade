// e2e/fixtures/fake-claude.mjs — pretends to be `claude`: writes a transcript + a mapping line, then idles.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const map = process.env.CANVAS_RECAP_MAP
const home = process.env.CANVAS_FAKE_HOME // e2e-controlled
const board = process.env.CANVAS_RECAP_BOARD || 'b'
const slug = (process.env.CANVAS_FAKE_CWD || 'p').replace(/[^a-zA-Z0-9]/g, '-')
const dir = join(home, '.claude', 'projects', slug)
mkdirSync(dir, { recursive: true })
const sid = 'fake-sess'
const tp = join(dir, sid + '.jsonl')
const T = '2026-06-07T14:32:00.000Z'
writeFileSync(
  tp,
  [
    JSON.stringify({
      type: 'user',
      timestamp: T,
      message: { role: 'user', content: 'review the auth service' }
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: T,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Found 3 issues in token.ts' }]
      }
    })
  ].join('\n') + '\n'
)
if (map)
  appendFileSync(
    map,
    JSON.stringify({
      boardId: board,
      sessionId: sid,
      transcriptPath: tp,
      cwd: process.env.CANVAS_FAKE_CWD,
      ts: 1
    }) + '\n'
  )
setInterval(() => {}, 1 << 30) // keep "running"
