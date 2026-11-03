import { test, expect } from './fixtures'
import { callE2E, mainCall, seed } from './helpers'

/**
 * Project Workspaces — WS-2 data model (schema v24, docs/research/2026-11-02-project-workspaces
 * §4.1). Drives the REAL persistence path end to end: a workspace is created + a board assigned
 * through the store actions, the doc goes through the real `project:save` IPC (MAIN's atomic writer
 * + envelope guard), the bytes on disk are checked for the v24 stamp, the live store is wiped, and
 * the project is reopened from disk through `project:open` → `applyOpenResult` → `fromObject`.
 *
 * A fresh temp project is minted at THIS build's schema, so the dev-build ESCHEMAFLOOR guard (a
 * floor RAISE over a prior doc) is a no-op by construction — this never touches a real project.
 */
type Ws = {
  id: string
  name: string
  goal: string
  color: string
  root: string
  worktrees?: unknown[]
  keepLayout?: boolean
}
type WsState = { workspaces: Ws[]; repoDefaults: Record<string, { base: string }> }

const WORKTREE = {
  repoRoot: 'uploader',
  worktree: '.canvas/worktrees/uploader-storage',
  branch: 'ws/uploader-storage',
  baseRef: 'release',
  base: '0123456789abcdef0123456789abcdef01234567'
}

test.describe('@core project workspaces (v24) — persistence', () => {
  test('a workspace + a board assignment survive save → disk → reopen', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'ws2-', 'ws2-persist')
    try {
      const opened = await callE2E<{ status: string }>(page, {
        m: 'openProjectFromDisk',
        a: [tmp]
      })
      expect(opened.status, 'fresh temp project opens clean').toBe('open')

      // Two planning boards (cheap — no PTY): one joins the workspace, one stays project-level.
      const inWs = await seed(page, 'planning', { title: 'API plan' })
      const projectLevel = await seed(page, 'planning', { title: 'Shared notes' })

      const apiId = await callE2E<string | null>(page, {
        m: 'createWorkspace',
        a: [{ name: 'API', goal: 'build auth', root: 'api' }]
      })
      const upId = await callE2E<string | null>(page, {
        m: 'createWorkspace',
        a: [{ name: 'Uploader', goal: 'enhance storage', root: 'uploader', worktrees: [WORKTREE] }]
      })
      expect(apiId, 'API workspace created').not.toBeNull()
      expect(upId, 'Uploader workspace created').not.toBeNull()
      await callE2E(
        page,
        { m: 'assignBoardsToWorkspace', a: [[inWs], apiId] },
        { m: 'setRepoDefaults', a: [{ uploader: { base: 'release' } }] }
      )
      const before = await callE2E<WsState>(page, { m: 'getWorkspaces' })
      expect(before.workspaces.map((w) => w.name)).toEqual(['API', 'Uploader'])

      // Flush through the REAL save IPC (the autosave path's own call). serialize→save stays in one
      // JS turn; the dir crosses as a structured arg, never into code.
      const saved = await page.evaluate<{ ok: boolean }, string>((dir) => {
        const g = globalThis as any
        return g.api.project.save(JSON.parse(g.__canvasE2E.serializeDoc()), dir)
      }, tmp)
      expect(saved.ok, 'project:save accepted the v24 doc').toBe(true)

      // The bytes on disk carry the v24 stamp + both workspaces + the membership.
      const path = await mainCall<string>(electronApp, 'joinPath', tmp, '.canvas', 'canvas.json')
      const raw = await mainCall<string | null>(electronApp, 'readTextFile', path)
      expect(raw, 'canvas.json written').not.toBeNull()
      const onDisk = JSON.parse(raw as string)
      expect(onDisk.schemaVersion).toBe(24)
      expect(onDisk.minReaderVersion).toBe(24)
      expect(onDisk.workspaces).toEqual(before.workspaces)
      expect(onDisk.repoDefaults).toEqual({ uploader: { base: 'release' } })
      const diskBoard = (id: string) => onDisk.boards.find((b: { id: string }) => b.id === id)
      expect(diskBoard(inWs).workspaceId).toBe(apiId)
      expect('workspaceId' in diskBoard(projectLevel)).toBe(false)

      // Wipe the live store so everything can ONLY come back from disk.
      await callE2E(page, { m: 'reset' })
      expect((await callE2E<WsState>(page, { m: 'getWorkspaces' })).workspaces).toEqual([])

      const reopened = await callE2E<{ status: string; boardCount: number }>(page, {
        m: 'openProjectFromDisk',
        a: [tmp]
      })
      expect(reopened.status, 'reopen succeeds').toBe('open')
      expect(reopened.boardCount).toBe(2)

      const after = await callE2E<WsState>(page, { m: 'getWorkspaces' })
      expect(after.workspaces, 'workspaces restored verbatim').toEqual(before.workspaces)
      expect(after.workspaces[1].worktrees).toEqual([WORKTREE])
      expect(after.repoDefaults).toEqual({ uploader: { base: 'release' } })

      const boards = await callE2E<{ id: string; workspaceId?: string }[]>(page, {
        m: 'getBoards'
      })
      const byId = Object.fromEntries(boards.map((b) => [b.id, b.workspaceId]))
      expect(byId[inWs], 'assigned board kept its workspace').toBe(apiId)
      expect(byId[projectLevel], 'project-level board stayed project-level').toBeUndefined()
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
