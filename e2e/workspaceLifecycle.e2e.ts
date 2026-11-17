import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { apiCall, callE2E, mainCall, seed } from './helpers'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * Project Workspaces — WS-4 lifecycle (docs/research/2026-11-02-project-workspaces §4.3), against
 * the REAL app: the New / Delete Workspace dialogs drive `window.api.workspace` → MAIN's
 * `workspaceStore` → the one worktree allocator (`simple-git`), in a real repo on disk.
 *
 * The fixture is deliberately awkward: the temp project path has a SPACE in it (`ws4 life-…`), and
 * so does the repo folder inside it (`svc api/`) — the class of path that broke winpty and every
 * naive `git` argv join. The project root itself is NOT a repo; `tickets/` is a plain folder.
 *
 * 🔒 The fixture repo is made by THIS process (`git init` here is the test's, never the app's —
 * the non-repo case asserts the app never runs one). Every git call is pinned to the throwaway repo
 * with an absolute GIT_DIR/GIT_WORK_TREE (the gitDiff.e2e.ts discipline), so it can never walk up
 * into the host checkout. Everything lives inside the temp project the spec deletes in `finally`.
 */

const REPO = 'svc api'
/** A carriage return — what the human's Enter sends to the PTY. */
const ENTER_KEY = '\r'

const gitIn =
  (repo: string) =>
  (...args: string[]): string =>
    execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_DIR: join(repo, '.git'),
        GIT_WORK_TREE: repo,
        GIT_AUTHOR_NAME: 'e2e',
        GIT_AUTHOR_EMAIL: 'e2e@example.com',
        GIT_COMMITTER_NAME: 'e2e',
        GIT_COMMITTER_EMAIL: 'e2e@example.com'
      },
      encoding: 'utf8'
    })

/** A real repo at `<tmp>/svc api` on `main`, one commit, plus a `release` branch one commit ahead. */
function makeRepo(tmp: string): (...args: string[]) => string {
  // SAFETY: only ever inside the temp project this spec minted.
  if (!tmp.includes('ws4 life-'))
    throw new Error(`refusing to make a repo outside the fixture: ${tmp}`)
  const repo = join(tmp, REPO)
  mkdirSync(repo, { recursive: true })
  const git = gitIn(repo)
  git('init', '-q')
  git('symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(repo, 'README.md'), '# fixture\n')
  // A manifest an install WOULD act on — so "Expanse never installs" is observable (no
  // node_modules ever appears in the worktree).
  writeFileSync(join(repo, 'package.json'), '{ "name": "fixture", "private": true }\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  git('branch', 'release')
  git('checkout', '-q', 'release')
  writeFileSync(join(repo, 'RELEASE.md'), 'release only\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'release')
  git('checkout', '-q', 'main')
  return git
}

type Ws = {
  id: string
  name: string
  root: string
  state?: string
  worktrees?: Array<{
    repoRoot: string
    worktree: string
    branch: string
    baseRef: string
    base: string
  }>
}
type WsState = { workspaces: Ws[]; repoDefaults: Record<string, { base: string }> }

const wsState = (page: Page): Promise<WsState> => callE2E<WsState>(page, { m: 'getWorkspaces' })
const wsNamed = async (page: Page, name: string): Promise<Ws | undefined> =>
  (await wsState(page)).workspaces.find((w) => w.name === name)

async function openProject(page: Page, tmp: string): Promise<void> {
  const opened = await callE2E<{ status: string }>(page, { m: 'openProjectFromDisk', a: [tmp] })
  expect(opened.status, 'fresh temp project opens clean').toBe('open')
  // A fresh project raises the one-time recap-consent modal — it would intercept the menu clicks.
  await page
    .getByRole('button', { name: /^no thanks$/i })
    .click({ timeout: 8000 })
    .catch(() => undefined)
}

const tid = (page: Page, id: string) => page.locator(`[data-test="${id}"]`)

async function openNewDialog(page: Page): Promise<void> {
  await tid(page, 'workspace-menu-btn').click()
  await tid(page, 'ws-new').click()
  await expect(tid(page, 'new-workspace-dialog')).toBeVisible()
}

/** Fill the dialog for a worktree workspace on the fixture repo (starter terminal OFF). */
async function fillWorktree(page: Page, name: string): Promise<void> {
  await tid(page, 'ws-name').fill(name)
  await tid(page, `ws-repo-${REPO}`).click()
  await tid(page, 'ws-mode-worktree').locator('button').click()
  await expect(tid(page, 'ws-base')).toBeVisible()
}

async function create(page: Page): Promise<void> {
  await tid(page, 'ws-create').click()
  await expect(tid(page, 'new-workspace-dialog')).toBeHidden({ timeout: 30_000 })
}

async function openDelete(page: Page, name: string): Promise<void> {
  await tid(page, 'workspace-menu-btn').click()
  await tid(page, `ws-delete-${name}`).click()
  await expect(tid(page, 'delete-workspace-dialog')).toBeVisible()
}

async function teardown(app: ElectronApplication, tmp: string): Promise<void> {
  // A live shell inside a worktree holds a Windows cwd lock; stop every PTY before the delete.
  await mainCall(app, 'disposeAllPtys').catch(() => undefined)
  await mainCall(app, 'teardownProject', tmp)
}

type Audit = { type: string; targetId: string; prompt: string; status: string }

/** Create a worktree workspace whose starter terminal runs `agent`, with the deps box ticked. */
async function createDepsWorkspace(
  page: Page,
  name: string,
  agent: string
): Promise<{ ws: Ws; term: { id: string }; depsEntries: () => Promise<Audit[]> }> {
  await openNewDialog(page)
  await fillWorktree(page, name)
  await expect(tid(page, 'ws-starter-terminal')).toBeChecked()
  await tid(page, 'ws-launch').fill(agent)
  await expect(tid(page, 'ws-deps')).toBeChecked()
  await create(page)
  const ws = await wsNamed(page, name)
  expect(ws, 'worktree workspace recorded').toBeTruthy()
  const boards = await callE2E<
    Array<{ id: string; type: string; workspaceId?: string; cwd?: string }>
  >(page, { m: 'getBoards' })
  const term = boards.find((b) => b.type === 'terminal' && b.workspaceId === ws!.id)
  expect(term, 'the starter terminal joined the workspace').toBeTruthy()
  expect(term!.cwd?.replace(/\\/g, '/')).toContain(`.canvas/worktrees/ws-${name.toLowerCase()}`)
  const depsEntries = async (): Promise<Audit[]> =>
    (await apiCall<Audit[]>(page, 'mcp.readAudit', { limit: 200 })).filter(
      (e) => e.type === 'workspace_deps_prompt' && e.targetId === term!.id
    )
  return { ws: ws!, term: term!, depsEntries }
}

test.describe('@workspace WS-4 lifecycle — create / delete against a real repo', () => {
  test('a folder that is not a repo: git modes disabled, folder workspace made, never `git init`', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'ws4 life-', 'ws4-folder')
    try {
      mkdirSync(join(tmp, 'tickets'))
      await openProject(page, tmp)
      await openNewDialog(page)
      await tid(page, 'ws-name').fill('Tickets')
      await tid(page, 'ws-folder').fill('tickets')
      await expect(tid(page, 'ws-git-reason')).toContainText('never runs `git init`')
      await expect(tid(page, 'ws-mode-worktree').locator('button')).toBeDisabled()
      await expect(tid(page, 'ws-mode-attach').locator('button')).toBeDisabled()
      await expect(tid(page, 'ws-mode-folder')).toHaveAttribute('data-on', 'true')
      await tid(page, 'ws-starter-terminal').uncheck()
      await create(page)

      const ws = await wsNamed(page, 'Tickets')
      expect(ws, 'folder workspace recorded').toBeTruthy()
      expect(ws!.root).toBe('tickets')
      expect(ws!.worktrees ?? []).toEqual([])
      // 🔒 Never init: no repo appeared anywhere the dialog touched.
      expect(existsSync(join(tmp, 'tickets', '.git'))).toBe(false)
      expect(existsSync(join(tmp, '.git'))).toBe(false)
      expect(existsSync(join(tmp, '.canvas', 'worktrees'))).toBe(false)
    } finally {
      await teardown(electronApp, tmp)
    }
  })

  test('worktree off a remembered base; first time asked, then pre-filled, then HEAD when it is gone; dirty delete archives, clean delete removes (branch + boards survive)', async ({
    page,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'ws4 life-', 'ws4-wt')
    try {
      const git = makeRepo(tmp)
      const releaseSha = git('rev-parse', 'release').trim()
      await openProject(page, tmp)

      // ── First worktree from this repo: the base is ASKED (no memory yet) ──
      await openNewDialog(page)
      await fillWorktree(page, 'API')
      await expect(tid(page, 'ws-base-first')).toBeVisible()
      await expect(tid(page, 'ws-base')).toHaveValue('main')
      await tid(page, 'ws-base').selectOption('release')
      await expect(tid(page, 'ws-remember')).toBeChecked()
      await tid(page, 'ws-starter-terminal').uncheck()
      await create(page)

      const api = await wsNamed(page, 'API')
      expect(api?.worktrees?.[0]).toMatchObject({
        repoRoot: REPO,
        worktree: '.canvas/worktrees/ws-api',
        branch: 'ws/api',
        baseRef: 'release',
        base: releaseSha
      })
      expect(existsSync(join(tmp, '.canvas', 'worktrees', 'ws-api', 'RELEASE.md'))).toBe(true)
      expect(git('branch', '--list', 'ws/api')).toContain('ws/api')
      expect((await wsState(page)).repoDefaults).toEqual({ [REPO]: { base: 'release' } })

      // ── Second time: the remembered base is pre-filled ──
      await openNewDialog(page)
      await fillWorktree(page, 'Second')
      await expect(tid(page, 'ws-base')).toHaveValue('release')
      await expect(tid(page, 'ws-base-remembered')).toBeVisible()
      await expect(tid(page, 'ws-base-first')).toHaveCount(0)
      await tid(page, 'ws-cancel').click()
      await expect(tid(page, 'new-workspace-dialog')).toBeHidden()

      // ── The remembered base disappears: HEAD stands in, with a notice ──
      git('branch', '-m', 'release', 'release-old')
      await openNewDialog(page)
      await fillWorktree(page, 'Clean')
      await expect(tid(page, 'ws-base-fallback')).toContainText('release')
      await expect(tid(page, 'ws-base')).toHaveValue('main')
      await tid(page, 'ws-starter-terminal').uncheck()
      await create(page)
      const clean = await wsNamed(page, 'Clean')
      expect(clean?.worktrees?.[0]).toMatchObject({ branch: 'ws/clean', baseRef: 'main' })

      // ── Dirty delete ⇒ prompted ⇒ Keep ⇒ archived (the tree stays, never --force) ──
      writeFileSync(join(tmp, '.canvas', 'worktrees', 'ws-api', 'wip.txt'), 'uncommitted\n')
      await openDelete(page, 'API')
      await expect(tid(page, 'wsdel-dirty')).toBeVisible()
      await expect(tid(page, 'wsdel-disp-keep')).toHaveAttribute('aria-pressed', 'true')
      await expect(tid(page, 'wsdel-confirm')).toHaveText(/archive workspace/i)
      await tid(page, 'wsdel-confirm').click()
      await expect(tid(page, 'delete-workspace-dialog')).toBeHidden()
      expect((await wsNamed(page, 'API'))?.state).toBe('archived')
      expect(existsSync(join(tmp, '.canvas', 'worktrees', 'ws-api', 'wip.txt'))).toBe(true)
      expect(git('branch', '--list', 'ws/api')).toContain('ws/api')
      await tid(page, 'workspace-menu-btn').click()
      await expect(tid(page, 'ws-row-API').locator('[data-test="ws-tag-archived"]')).toBeVisible()
      await page.keyboard.press('Escape')

      // ── Clean delete removes the tree; the branch survives; its boards stay, project-level (O-8) ──
      const board = await seed(page, 'planning', { title: 'Clean notes' })
      await callE2E(page, { m: 'assignBoardsToWorkspace', a: [[board], clean!.id] })
      await openDelete(page, 'Clean')
      await expect(tid(page, 'wsdel-clean')).toBeVisible()
      await expect(tid(page, 'wsdel-keep-boards')).toHaveAttribute('aria-pressed', 'true')
      await tid(page, 'wsdel-confirm').click()
      await expect(tid(page, 'delete-workspace-dialog')).toBeHidden({ timeout: 30_000 })
      expect(await wsNamed(page, 'Clean')).toBeUndefined()
      expect(existsSync(join(tmp, '.canvas', 'worktrees', 'ws-clean'))).toBe(false)
      expect(git('branch', '--list', 'ws/clean')).toContain('ws/clean')
      const boards = await callE2E<Array<{ id: string; workspaceId?: string }>>(page, {
        m: 'getBoards'
      })
      const kept = boards.find((b) => b.id === board)
      expect(kept, 'the board outlives its workspace').toBeTruthy()
      expect(kept!.workspaceId).toBeUndefined()
    } finally {
      await teardown(electronApp, tmp)
    }
  })

  test('"install dependencies" ticked: exactly ONE fixed prompt reaches the starter agent; Expanse installs nothing', async ({
    page,
    electronApp
  }) => {
    test.setTimeout(150_000)
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'ws4 life-', 'ws4-deps')
    try {
      makeRepo(tmp)
      await openProject(page, tmp)

      // A stand-in "agent" that reads one line and does nothing with it — so the prompt is
      // delivered, observed, and provably NOT acted on by anything Expanse runs.
      const agent = process.platform === 'win32' ? "$null = Read-Host 'agent'" : 'read -r x'
      const { ws, term, depsEntries } = await createDepsWorkspace(page, 'Deps', agent)
      await expect
        .poll(async () => (await depsEntries()).map((e) => e.status), { timeout: 90_000 })
        .toEqual([expect.stringMatching(/^dispatched/)])
      const [entry] = await depsEntries()
      expect(entry.prompt).toMatch(
        /^This is a fresh git worktree, so its dependencies are not installed\./
      )

      // The arm is single-use: a second ask from the renderer is refused and writes nothing.
      const again = await apiCall<{ ok: boolean }>(page, 'workspace.depsPrompt', ws.id, term.id)
      expect(again.ok).toBe(false)
      expect(await depsEntries()).toHaveLength(1)
      // Expanse ran no install of its own: nothing landed in the worktree beyond the checkout.
      const wt = join(tmp, '.canvas', 'worktrees', 'ws-deps')
      expect(readdirSync(wt)).not.toContain('node_modules')
    } finally {
      await teardown(electronApp, tmp)
    }
  })

  // Dev-check finding (2026-11-03): in a fresh worktree Claude Code first asks "trust this folder?"
  // and the prompt's Enter answered it with the default — "No, exit". The stand-in agent here asks
  // the same shaped question, then (once answered) waits at a prompt like a booted REPL.
  test('an agent asking its first-run trust question: the prompt is HELD, then sent by the human — once', async ({
    page,
    electronApp
  }) => {
    test.setTimeout(150_000)
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'ws4 life-', 'ws4-trust')
    try {
      makeRepo(tmp)
      await openProject(page, tmp)
      const agent =
        process.platform === 'win32'
          ? "Write-Host 'Do you trust the files in this folder?'; Write-Host ' Enter to confirm'; $null = Read-Host; Write-Host 'agent ready'; $null = Read-Host 'agent'"
          : "printf 'Do you trust the files in this folder?\\n Enter to confirm\\n'; read -r a; echo 'agent ready'; read -r b"
      const { term, depsEntries } = await createDepsWorkspace(page, 'Trust', agent)

      const held = tid(page, 'toast-island').getByText(/trust this new worktree/)
      await expect(held).toBeVisible({ timeout: 90_000 })
      expect(await depsEntries(), 'nothing is written into the trust question').toEqual([])

      // The human answers the agent's question in the terminal…
      expect(await mainCall<boolean>(electronApp, 'writeTerminal', term.id, ENTER_KEY)).toBe(true)
      // …then sends the held prompt from the toast.
      await tid(page, 'toast-island')
        .getByRole('button', { name: 'Send dependency prompt' })
        .click()
      await expect
        .poll(async () => (await depsEntries()).map((e) => e.status), { timeout: 60_000 })
        .toEqual([expect.stringMatching(/^dispatched/)])
      await expect(held).toBeHidden()
    } finally {
      await teardown(electronApp, tmp)
    }
  })
})
