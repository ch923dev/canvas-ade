import { describe, it, expect } from 'vitest'
import {
  toNodes,
  mergeChildren,
  applyListing,
  compactTree,
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

describe('fileTreeData.compactTree', () => {
  it('merges a loaded single-folder chain into one compound row (top id kept, deepest children)', () => {
    const tree: FileNode[] = [
      {
        id: 'a',
        name: 'a',
        isDir: true,
        loaded: true,
        children: [
          {
            id: 'a/b',
            name: 'b',
            isDir: true,
            loaded: true,
            children: [{ id: 'a/b/c.ts', name: 'c.ts', isDir: false }]
          }
        ]
      }
    ]
    const [node] = compactTree(tree)
    expect(node.id).toBe('a') // top id kept → arborist open state stays stable
    expect(node.segments?.map((s) => s.name)).toEqual(['a', 'b'])
    expect(node.children?.map((c) => c.id)).toEqual(['a/b/c.ts']) // deepest's children exposed
  })

  it('does NOT merge across an unloaded link, a multi-child folder, or a file child', () => {
    const tree: FileNode[] = [
      { id: 'unl', name: 'unl', isDir: true, children: [{ id: 'unl/x', name: 'x', isDir: true }] },
      {
        id: 'multi',
        name: 'multi',
        isDir: true,
        loaded: true,
        children: [
          { id: 'multi/a', name: 'a', isDir: true },
          { id: 'multi/b', name: 'b', isDir: true }
        ]
      },
      {
        id: 'leaf',
        name: 'leaf',
        isDir: true,
        loaded: true,
        children: [{ id: 'leaf/f.ts', name: 'f.ts', isDir: false }]
      }
    ]
    const out = compactTree(tree)
    expect(out.every((n) => n.segments === undefined)).toBe(true)
  })
})
