import { describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listFiles, readFileSafe, resolveInside } from '../src/main/lib/file-browser'

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'damon-test-'))
  writeFileSync(join(root, 'readme.md'), '# hello')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'app.ts'), 'console.log(1)')
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'x', 'ignore.js'), 'nope')
  mkdirSync(join(root, '.damon'))
  writeFileSync(join(root, '.damon', 'chat.json'), '[]')
  return root
}

describe('listFiles', () => {
  test('lists dirs first, ignores node_modules and .damon', () => {
    const tree = listFiles(setup())
    expect(tree.map((n) => n.name)).toEqual(['src', 'readme.md'])
    expect(tree[0]!.kind).toBe('dir')
    expect(tree[0]!.children!.map((n) => n.name)).toEqual(['app.ts'])
    expect(tree[1]!.rel).toBe('readme.md')
  })
})

describe('readFileSafe', () => {
  test('junctions cannot expose another project, including through missing child paths', () => {
    const root = setup(), sibling = setup()
    symlinkSync(sibling, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(resolveInside(root, 'escape/readme.md')).toBeNull()
    expect(resolveInside(root, 'escape/new.txt')).toBeNull()
    expect(readFileSafe(root, 'escape/readme.md').ok).toBe(false)
    expect(listFiles(root).some(item => item.name === 'escape')).toBe(false)
    expect(resolveInside(root, 'readme.md:private-stream')).toBeNull()
  })
  test('reads a normal file', () => {
    const root = setup()
    expect(readFileSafe(root, 'readme.md')).toEqual({ ok: true, content: '# hello' })
    expect(readFileSafe(root, join('src', 'app.ts'))).toEqual({ ok: true, content: 'console.log(1)' })
  })

  test('refuses paths outside the project', () => {
    const root = setup()
    const result = readFileSafe(root, '..\\..\\Windows\\win.ini')
    expect(result.ok).toBe(false)
  })

  test('refuses missing, huge, and binary files with plain-language reasons', () => {
    const root = setup()
    expect(readFileSafe(root, 'nope.txt').ok).toBe(false)
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(600_000))
    const big = readFileSafe(root, 'big.txt')
    expect(big.ok).toBe(false)
    writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 0, 2, 0, 3]))
    const bin = readFileSafe(root, 'bin.dat')
    expect(bin.ok).toBe(false)
  })
})
