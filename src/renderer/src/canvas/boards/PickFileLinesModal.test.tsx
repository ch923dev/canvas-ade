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

  it('filters file rows by name (dirs stay for navigation)', async () => {
    mockFileApi({
      '': [
        { name: 'src', isDir: true },
        { name: 'README.md', isDir: false },
        { name: 'LICENSE', isDir: false }
      ]
    })
    render(<PickFileLinesModal onPick={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy())
    fireEvent.change(screen.getByTestId('pfl-filter'), { target: { value: 'readme' } })
    expect(screen.getByText('README.md')).toBeTruthy()
    expect(screen.queryByText('LICENSE')).toBeNull()
    expect(screen.getByText('src')).toBeTruthy() // dir stays visible
  })
})
