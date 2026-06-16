import { describe, it, expect } from 'vitest'
import {
  toNodes,
  mergeChildren,
  applyListing,
  findNode,
  parentOf,
  type FileNode
} from './fileTreeData'

describe('fileTreeData.toNodes', () => {
  it('builds forward-slashed ids and orders dirs-first then case-insensitive name', () => {
    const nodes = toNodes('src', [
      { name: 'utils.ts', isDir: false },
      { name: 'Components', isDir: true },
      { name: 'app.tsx', isDir: false },
      { name: 'assets', isDir: true }
    ])
    expect(nodes.map((n) => n.id)).toEqual([
      'src/assets',
      'src/Components',
      'src/app.tsx',
      'src/utils.ts'
    ])
  })
  it('roots ids without a leading slash', () => {
    expect(toNodes('', [{ name: 'README.md', isDir: false }])[0].id).toBe('README.md')
  })
})

describe('fileTreeData.mergeChildren', () => {
  it('carries over a loaded subdir’s children so a refresh never collapses it', () => {
    const prev: FileNode[] = [
      {
        id: 'src',
        name: 'src',
        isDir: true,
        loaded: true,
        children: [{ id: 'src/a.ts', name: 'a.ts', isDir: false }]
      }
    ]
    const fresh = toNodes('', [
      { name: 'src', isDir: true },
      { name: 'new.ts', isDir: false }
    ])
    const merged = mergeChildren(prev, fresh)
    const src = merged.find((n) => n.id === 'src')
    expect(src?.loaded).toBe(true)
    expect(src?.children).toHaveLength(1)
    expect(merged.some((n) => n.id === 'new.ts')).toBe(true)
  })
  it('drops a previously-loaded folder that no longer exists', () => {
    const prev: FileNode[] = [{ id: 'gone', name: 'gone', isDir: true, loaded: true, children: [] }]
    const merged = mergeChildren(prev, toNodes('', [{ name: 'kept.ts', isDir: false }]))
    expect(merged.map((n) => n.id)).toEqual(['kept.ts'])
  })
})

describe('fileTreeData.applyListing', () => {
  it('replaces root children when parentId is ""', () => {
    const out = applyListing([], '', [{ name: 'a.ts', isDir: false }])
    expect(out.map((n) => n.id)).toEqual(['a.ts'])
  })
  it('loads a nested folder and marks it loaded without touching siblings', () => {
    const prev: FileNode[] = [
      { id: 'src', name: 'src', isDir: true },
      { id: 'docs', name: 'docs', isDir: true }
    ]
    const out = applyListing(prev, 'src', [{ name: 'index.ts', isDir: false }])
    const src = findNode(out, 'src')
    expect(src?.loaded).toBe(true)
    expect(src?.children?.map((n) => n.id)).toEqual(['src/index.ts'])
    expect(findNode(out, 'docs')?.loaded).toBeUndefined()
  })
})

describe('fileTreeData.findNode / parentOf', () => {
  it('finds a deeply nested node by id', () => {
    const tree: FileNode[] = [
      {
        id: 'a',
        name: 'a',
        isDir: true,
        children: [
          {
            id: 'a/b',
            name: 'b',
            isDir: true,
            children: [{ id: 'a/b/c.ts', name: 'c.ts', isDir: false }]
          }
        ]
      }
    ]
    expect(findNode(tree, 'a/b/c.ts')?.name).toBe('c.ts')
    expect(findNode(tree, 'a/missing')).toBeNull()
  })
  it('parentOf returns the parent dir or "" at root', () => {
    expect(parentOf('src/lib/x.ts')).toBe('src/lib')
    expect(parentOf('top.ts')).toBe('')
  })
})
