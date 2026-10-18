import { describe, expect, test } from 'vitest'
import { capabilitiesIn, depthForWork, hasVisibleSurface } from '../src/shared/review'
import { agentSystemPrompt } from '../src/main/lib/agent-prompt'
import type { AgentInfo } from '../src/shared/types'

describe('every capability a job touches', () => {
  test('reports all of them, not only the ones that set the depth', () => {
    const all = capabilitiesIn('Build the sign-in screen and the tables behind it')
    expect(all).toContain('screens')
    expect(all).toContain('permission')
    expect(all).toContain('data')
  })

  test('depth is unchanged by the refactor', () => {
    expect(depthForWork('Build the sign-in screen and the tables behind it').depth).toBe('full')
    expect(depthForWork('Build the settings page').depth).toBe('single')
    expect(depthForWork('Work out the monthly running cost').depth).toBe('none')
  })
})

describe('whether there is anything to look at', () => {
  test('a screen is visible even when something riskier is also in play', () => {
    expect(hasVisibleSurface('Build the sign-in screen and the tables behind it')).toBe(true)
  })

  test('plain screen work is visible', () => {
    expect(hasVisibleSurface('Build the group home page')).toBe(true)
    expect(hasVisibleSurface('Fix the layout of the invite form')).toBe(true)
  })

  test('work with no visible surface is not', () => {
    expect(hasVisibleSurface('Add the groups tables and a migration')).toBe(false)
    expect(hasVisibleSurface('Write up the deviations log')).toBe(false)
    expect(hasVisibleSurface('Work out the monthly running cost')).toBe(false)
  })

  test('empty or missing text is not visible, rather than throwing', () => {
    expect(hasVisibleSurface('')).toBe(false)
    expect(hasVisibleSurface(undefined as unknown as string)).toBe(false)
  })
})

const SCOUT: AgentInfo = {
  id: 'a1',
  name: 'Scout',
  role: 'builds screens',
  model: 'claude-sonnet-5',
  createdAt: 'x'
}
const MEMORY = { agentMd: '', memoryMd: '', rejections: [] }

describe('what an agent building something visible is told', () => {
  test('it is pointed at the UI and UX skills', () => {
    const p = agentSystemPrompt(SCOUT, 'Demo', MEMORY, '', { visibleSurface: true })
    expect(p).toMatch(/skill/i)
    expect(p).toMatch(/ui-ux-pro-max/)
  })

  test('it is told the work will actually be looked at', () => {
    const p = agentSystemPrompt(SCOUT, 'Demo', MEMORY, '', { visibleSurface: true })
    expect(p).toMatch(/looked at|screenshot|photograph|see how it renders/i)
  })

  test('and that it can look itself, three times a round', () => {
    const p = agentSystemPrompt(SCOUT, 'Demo', MEMORY, '', { visibleSurface: true })
    expect(p).toContain('look_at_my_work')
    expect(p).toContain('three looks')
  })

  test('it is pointed at research that comes back as words, never a layout to copy', () => {
    const p = agentSystemPrompt(SCOUT, 'Demo', MEMORY, '', { visibleSurface: true })
    expect(p).toContain('study_this')
    expect(p.toLowerCase()).toContain('never rebuild somebody else')
  })

  test('an agent with nothing visible to build is not told any of it', () => {
    const p = agentSystemPrompt(SCOUT, 'Demo', MEMORY, '', { visibleSurface: false })
    expect(p).not.toMatch(/ui-ux-pro-max/)
  })

  test('an older caller that passes nothing behaves as before', () => {
    const p = agentSystemPrompt(SCOUT, 'Demo', MEMORY)
    expect(p).not.toMatch(/ui-ux-pro-max/)
  })
})
