import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createProject, setCurrentDir } from '../../projectStore'
import { createCanvasMemory } from '../../canvasMemory'
import type { E2EProbe } from '../types'

/**
 * M-memory T-M1: the `.canvas/` engine. Creates a throwaway project (mirrors the W4/W5
 * asset probes — project-rooted, so it needs a project dir, NOT a userData temp), then
 * asserts: (1) createProject scaffolded `.canvas/memory` + `.canvas/audit` + a
 * default-private `.gitignore` (`*`); (2) a board summary round-trips on disk under the
 * PROJECT dir; (3) the memory lives under the project dir, never userData. No LLM (T-M1
 * is the storage layer; the Tier-2 loop is T-M3).
 */
export const contextMemory: E2EProbe = {
  name: 'context-memory',
  async run(ctx) {
    void ctx // MAIN-side only: no renderer interaction needed for the storage layer
    const tmp = mkdtempSync(join(tmpdir(), 'canvas-m1-'))
    // W4/W5 order: create the project, THEN point the open dir at it; restore + clean in finally
    // so a future probe added after this one is never left with a stale currentDir / leaked dir.
    try {
      await createProject(tmp, 'm1', {})
      setCurrentDir(tmp)

      const mem = createCanvasMemory(tmp)
      const scaffolded =
        existsSync(mem.paths.memoryDir) &&
        existsSync(mem.paths.auditDir) &&
        existsSync(mem.paths.gitignore)
      const ignoreOk = scaffolded && readFileSync(mem.paths.gitignore, 'utf8') === '*\n'

      const wrote = mem.writeBoard('e2e-board', '# Board\n\nstub summary\n')
      const roundTrip = mem.readBoard('e2e-board') === '# Board\n\nstub summary\n'
      const onDisk = existsSync(join(tmp, '.canvas', 'memory', 'board-e2e-board.md'))
      const underProject = mem.paths.board('e2e-board').startsWith(join(tmp, '.canvas'))

      const ok = scaffolded && ignoreOk && wrote && roundTrip && onDisk && underProject
      return {
        name: 'context-memory',
        ok,
        detail: ok
          ? `scaffolded + board-e2e-board.md round-trips under ${join(tmp, '.canvas')}`
          : JSON.stringify({ scaffolded, ignoreOk, wrote, roundTrip, onDisk, underProject })
      }
    } finally {
      setCurrentDir(null)
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}
