import { describe, expect, test } from 'vitest'
import { safeToOpen, RUNNABLE } from '../src/shared/openable'

describe('safeToOpen', () => {
  test('ordinary work opens', () => {
    for (const f of ['report.pdf', 'notes.md', 'sheet.xlsx', 'shot.png', 'deck.pptx', 'clip.mp4']) {
      expect(safeToOpen(f), f).toBe(true)
    }
  })

  test('a program does not, whatever it is called', () => {
    for (const f of ['setup.exe', 'run.bat', 'go.cmd', 'x.ps1', 'x.vbs', 'x.scr', 'x.msi', 'shortcut.lnk']) {
      expect(safeToOpen(f), f).toBe(false)
    }
  })

  test('a program wearing a document name does not open', () => {
    expect(safeToOpen('Your finished report.pdf.exe')).toBe(false)
    expect(safeToOpen('invoice.docx.bat')).toBe(false)
  })

  test('case and trailing dots do not get past it', () => {
    expect(safeToOpen('SETUP.EXE')).toBe(false)
    expect(safeToOpen('setup.ExE')).toBe(false)
  })

  test('a file with no ending at all does not open', () => {
    expect(safeToOpen('README')).toBe(false)
  })

  test('every entry in the list is lowercase and starts with a dot', () => {
    for (const ext of RUNNABLE) {
      expect(ext, ext).toBe(ext.toLowerCase())
      expect(ext.startsWith('.'), ext).toBe(true)
    }
  })
})
