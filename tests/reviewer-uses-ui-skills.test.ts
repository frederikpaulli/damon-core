import { describe, expect, test } from 'vitest'
import { interfaceFiles, reviewerBrief } from '../src/shared/review'

const brief = (files: string[]): string =>
  reviewerBrief({
    taskTitle: 'Build the calendar screen',
    criteria: 'It shows every dated fact.',
    artifacts: files.map((f) => ({ file: f, how: 'edited' })),
    round: 1,
    previousObjections: []
  })

describe('which changed files are an interface', () => {
  test.each([
    'src/screens/today/TodayScreen.tsx',
    'src/shell/AppShell.jsx',
    'src/design-system/tokens.css',
    'src/charts/charts.scss',
    'index.html',
    'src/App.vue',
    'src/Thing.svelte'
  ])('%s counts', (f) => {
    expect(interfaceFiles([f])).toEqual([f])
  })

  test.each([
    'src-tauri/src/domain/rent.rs',
    'docs/contracts/backend.md',
    'package.json',
    'src/lib/money.ts',
    'tests/rent.test.ts'
  ])('%s does not', (f) => {
    expect(interfaceFiles([f])).toEqual([])
  })

  test('a mixed job reports only the interface half', () => {
    expect(interfaceFiles(['src-tauri/src/lib.rs', 'src/screens/Today.tsx', 'README.md'])).toEqual([
      'src/screens/Today.tsx'
    ])
  })
})

describe('what the reviewer is told when a job touched the interface', () => {
  const said = brief(['src/screens/today/TodayScreen.tsx', 'src/design-system/tokens.css'])

  test('it is told to run the installed interface checks', () => {
    expect(said).toContain('web-design-guidelines')
    expect(said).toContain('impeccable')
  })

  test('and that what they flag is a finding, not a suggestion', () => {
    expect(said.toLowerCase()).toContain('findings')
  })

  test('a checker that is not installed is reported, not skipped quietly', () => {
    expect(said.toLowerCase()).toContain('not installed')
  })

  test('it names the interface files, so it does not check the whole project', () => {
    expect(said).toContain('src/screens/today/TodayScreen.tsx')
    expect(said).toContain('src/design-system/tokens.css')
  })
})

describe('what it is told when the job touched no interface at all', () => {
  const said = brief(['src-tauri/src/domain/rent.rs', 'docs/contracts/backend.md'])

  test('the interface checks are not mentioned', () => {
    expect(said).not.toContain('web-design-guidelines')
    expect(said).not.toContain('impeccable')
  })

  test('but the rest of the brief is unchanged', () => {
    expect(said).toContain('src-tauri/src/domain/rent.rs')
    expect(said).toContain('acceptance criteria')
  })
})
