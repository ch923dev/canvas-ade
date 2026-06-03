import { mkdtempSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createProject, setCurrentDir, readProject, writeProject } from '../../projectStore'
import { createCanvasMemory } from '../../canvasMemory'
import { createSummaryLoop } from '../../summaryLoop'
import type { Encryptor } from '../../llmKeyStore'
import type { E2EProbe } from '../types'

/**
 * M-memory T-M3: the Tier-2 autonomous summary loop. Drives createSummaryLoop directly
 * (MAIN-side, like context-memory) under the e2e MOCK provider (CANVAS_SMOKE=e2e →
 * getProvider returns the [mock] summarizer, NO real network). Creates a throwaway
 * project with one planning board, points the open dir at it, writes a real canvas.json
 * (so readProject finds the board), fires onIntent, and asserts: board-<id>.md was
 * written with the mock summary AND MEMORY.md lists the board. Self-cleans (restore
 * setCurrentDir(null) + rm the temp dirs in finally). Runs late — it touches currentDir.
 */
export const contextSummary: E2EProbe = {
  name: 'context-summary',
  async run(ctx) {
    void ctx // MAIN-side only: no renderer interaction needed for the loop
    const proj = mkdtempSync(join(tmpdir(), 'canvas-m3-'))
    const llmDataDir =
      process.env.CANVAS_E2E_LLM_DIR ?? mkdtempSync(join(tmpdir(), 'canvas-m3-llm-'))
    const noopEncryptor: Encryptor = {
      isEncryptionAvailable: () => false,
      encryptString: (s) => Buffer.from(s, 'utf8'),
      decryptString: (b) => Buffer.from(b).toString('utf8')
    }
    try {
      // A real canvas.json with one planning board (note text becomes the summarize input).
      await createProject(proj, 'm3', {})
      setCurrentDir(proj)
      const doc = {
        schemaVersion: 4,
        viewport: null,
        boards: [
          {
            id: 'm3board',
            type: 'planning',
            x: 0,
            y: 0,
            w: 400,
            h: 300,
            title: 'Plan',
            elements: [
              {
                id: 'n1',
                kind: 'note',
                x: 0,
                y: 0,
                w: 100,
                h: 80,
                tint: 'yellow',
                text: 'ship T-M3'
              }
            ]
          }
        ]
      }
      await writeProject(proj, doc)

      const loop = createSummaryLoop({
        llmDataDir,
        encryptor: noopEncryptor,
        getCurrentDir: () => proj,
        readProject
      })
      await loop.onIntent({ boardId: 'm3board' })

      const mem = createCanvasMemory(proj)
      const board = mem.readBoard('m3board')
      const index = mem.readIndex()
      const wroteSummary = !!board && board.includes('[mock]') && board.includes('ship T-M3')
      const onDisk = existsSync(join(proj, '.canvas', 'memory', 'board-m3board.md'))
      const indexLists = !!index && index.includes('board-m3board.md')

      const ok = wroteSummary && onDisk && indexLists
      return {
        name: 'context-summary',
        ok,
        detail: ok
          ? 'mock summary cached to board-m3board.md + MEMORY.md lists the board'
          : JSON.stringify({ wroteSummary, onDisk, indexLists, board })
      }
    } finally {
      setCurrentDir(null)
      rmSync(proj, { recursive: true, force: true })
    }
  }
}
