/**
 * PickFileLinesModal — jsdom tier. Covers the lazy file tree (listDir) + the Add-guard. The
 * CodeMirror line-selection itself is a real-editor concern left to the e2e / manual check; these
 * pin the tree wiring + the "can't Add without a file" guard against a mocked file IPC.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { PickFileLinesModal } from './PickFileLinesModal'

type Entry = { name: string; isDir: boolean }

afterEach(() => {
  cleanup()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).api
  vi.restoreAllMocks()
})

function mockFileApi(listing: Record<string, Entry[]>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = {
    file: {
      listDir: vi.fn(async (p: string) => listing[p] ?? []),
      readText: vi.fn(async () => 'line1\nline2\nline3\n')
    }
  }
}

describe('PickFileLinesModal', () => {
  it('renders the project root from listDir and lazily expands a directory', async () => {
    mockFileApi({
      '': [
        { name: 'src', isDir: true },
        { name: 'README.md', isDir: false }
      ],
      src: [{ name: 'a.ts', isDir: false }]
    })
    render(<PickFileLinesModal onPick={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('src')).toBeTruthy())
    expect(screen.getByText('README.md')).toBeTruthy()
    // the child isn't listed until its dir is expanded
    expect(screen.queryByText('a.ts')).toBeNull()
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => expect(screen.getByText('a.ts')).toBeTruthy())
  })

  it('disables "Add ref" until a file is picked', () => {
    mockFileApi({ '': [{ name: 'README.md', isDir: false }] })
    render(<PickFileLinesModal onPick={() => {}} onClose={() => {}} />)
    expect((screen.getByTestId('pfl-add') as HTMLButtonElement).disabled).toBe(true)
  })

  it('ignores a stale read that resolves after a newer file was picked', async () => {
    // A's readText resolves AFTER B's — A must not clobber B's content in the editor.
    const deferred: Record<string, { resolve: (v: string) => void }> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      file: {
        listDir: vi.fn(async () => [
          { name: 'a.ts', isDir: false },
          { name: 'b.ts', isDir: false }
        ]),
        readText: vi.fn(
          (p: string) =>
            new Promise<string>((resolve) => {
              deferred[p] = { resolve }
            })
        )
      }
    }
    const onPick = vi.fn()
    render(<PickFileLinesModal onPick={onPick} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('a.ts')).toBeTruthy())

    fireEvent.click(screen.getByText('a.ts')) // request 1 (A)
    fireEvent.click(screen.getByText('b.ts')) // request 2 (B) — now the latest
    // Resolve B first, then A. A is stale and must be dropped.
    deferred['b.ts'].resolve('BBB')
    deferred['a.ts'].resolve('AAA')

    // The committed ref keeps B's path regardless of resolution order.
    await waitFor(() =>
      expect((screen.getByTestId('pfl-add') as HTMLButtonElement).disabled).toBe(false)
    )
    fireEvent.click(screen.getByTestId('pfl-add'))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ path: 'b.ts' }))
  })

  it('a filter runs a RECURSIVE search → flat file matches across dirs, folders hidden (#346)', async () => {
    mockFileApi({
      '': [
        { name: 'src', isDir: true },
        { name: 'README.md', isDir: false },
        { name: 'LICENSE', isDir: false }
      ],
      // A nested file the OLD shallow filter could never reach — the recursive walk finds it.
      src: [{ name: 'readme-notes.txt', isDir: false }]
    })
    render(<PickFileLinesModal onPick={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.change(screen.getByTestId('pfl-filter'), { target: { value: 'readme' } })
    // Debounced recursive walk → flat matches: README.md + the nested src/readme-notes.txt.
    await waitFor(() => expect(screen.getByText('readme-notes.txt')).toBeTruthy())
    expect(screen.getByText('README.md')).toBeTruthy()
    expect(screen.queryByText('LICENSE')).toBeNull() // non-match dropped
    // No navigable FOLDER rows in search results (the nested match still shows its parent as a dir label).
    expect(document.querySelectorAll('.pfl-row.dir').length).toBe(0)
  })

  it('clearing the filter returns to the browse tree (folders visible again) (#346)', async () => {
    mockFileApi({
      '': [
        { name: 'src', isDir: true },
        { name: 'README.md', isDir: false }
      ]
    })
    render(<PickFileLinesModal onPick={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('src')).toBeTruthy())
    fireEvent.change(screen.getByTestId('pfl-filter'), { target: { value: 'readme' } })
    await waitFor(() => expect(screen.queryByText('src')).toBeNull())
    fireEvent.change(screen.getByTestId('pfl-filter'), { target: { value: '' } })
    await waitFor(() => expect(screen.getByText('src')).toBeTruthy()) // tree restored
  })
})
