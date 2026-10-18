import { describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSafe, resolveInside } from '../src/main/lib/file-browser'

const dir = (): string => mkdtempSync(join(tmpdir(), 'damon-files-'))

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

describe('readFileSafe with pictures', () => {
  test('a png comes back as an image, not as a refusal', () => {
    const root = dir()
    writeFileSync(join(root, 'shot.png'), PNG)
    const r = readFileSafe(root, 'shot.png')

    expect(r.ok).toBe(true)
    expect(r.ok && 'image' in r && r.image.startsWith('data:image/png;base64,')).toBe(true)
  })

  test('the picture is matched on its kind, whatever the case of the name', () => {
    const root = dir()
    writeFileSync(join(root, 'SHOT.PNG'), PNG)

    expect(readFileSafe(root, 'SHOT.PNG').ok).toBe(true)
  })

  test('text is still text', () => {
    const root = dir()
    writeFileSync(join(root, 'notes.md'), '# hello', 'utf8')
    const r = readFileSafe(root, 'notes.md')

    expect(r.ok && 'content' in r && r.content).toBe('# hello')
  })

  test('a picture outside the project folder is still refused', () => {
    const root = dir()
    expect(readFileSafe(root, '../escape.png').ok).toBe(false)
  })

  test('something binary that is not a picture is still refused', () => {
    const root = dir()
    writeFileSync(join(root, 'thing.bin'), Buffer.from([0, 1, 2, 0, 3]))

    expect(readFileSafe(root, 'thing.bin').ok).toBe(false)
  })
})

describe('resolveInside', () => {
  test('keeps a path inside the project', () => {
    const root = dir()
    expect(resolveInside(root, 'out/report.pdf')).not.toBeNull()
  })

  test('refuses climbing out, an absolute path, and the root itself', () => {
    const root = dir()
    expect(resolveInside(root, '../escape.docx')).toBeNull()
    expect(resolveInside(root, 'a/../../escape.docx')).toBeNull()
    expect(resolveInside(root, 'C:\\Windows\\evil.dll')).toBeNull()
    expect(resolveInside(root, 'C:evil.dll')).toBeNull()
  })
})
