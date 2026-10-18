import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo } from '../src/shared/types'
import { MemoryStore } from '../src/main/lib/memory-store'

const agent: AgentInfo = { id: 'a1', name: 'Scout', role: 'Frontend builder', model: 'claude-sonnet-5', createdAt: 'x' }

const setup = (): MemoryStore => new MemoryStore(mkdtempSync(join(tmpdir(), 'damon-mem-')))

describe('MemoryStore', () => {
  test('load seeds AGENT.md from the role and an empty MEMORY.md', () => {
    const store = setup()
    const memory = store.load(agent, 'My Site')
    expect(memory.agentMd).toContain('Scout')
    expect(memory.agentMd).toContain('Frontend builder')
    expect(memory.agentMd).toContain('My Site')
    expect(memory.memoryMd).toContain('learned')
  })

  test('seeding never overwrites an existing identity', () => {
    const store = setup()
    store.load(agent, 'First Project')
    const again = store.load({ ...agent, role: 'Totally different' }, 'Other')
    expect(again.agentMd).toContain('Frontend builder')
    expect(again.agentMd).not.toContain('Totally different')
  })

  test('addNotes appends dated bullets and skips duplicates', () => {
    const store = setup()
    store.load(agent, 'P')
    store.addNotes(agent.id, ['The owner prefers blue buttons', 'Tests live in /tests'])
    store.addNotes(agent.id, ['The owner prefers blue buttons'])
    const memory = store.load(agent, 'P')
    expect(memory.memoryMd).toContain('blue buttons')
    expect(memory.memoryMd).toContain('/tests')
    expect(memory.memoryMd.match(/blue buttons/g)).toHaveLength(1)
  })

  test('relevant() ranks bullets by shared words with the task', () => {
    const store = setup()
    store.load(agent, 'P')
    store.addNotes(agent.id, [
      'The login page uses a blue button',
      'Database backups run every night',
      'Login errors should show under the field'
    ])
    const hits = store.relevant(agent.id, 'fix the login button styling', 3)
    expect(hits.join(' ')).toContain('login page uses a blue button')
    expect(hits.some((h) => h.includes('backups'))).toBe(false)
  })

  test('memory is consolidated: oldest bullets drop when over budget', () => {
    const store = setup()
    store.load(agent, 'P')
    for (let i = 0; i < 60; i++) {
      store.addNotes(agent.id, [`Lesson number ${i} with some padding text to grow the file well beyond budget`])
    }
    const memory = store.load(agent, 'P')
    expect(memory.memoryMd.length).toBeLessThanOrEqual(2600)
    expect(memory.memoryMd).toContain('Lesson number 59')
    expect(memory.memoryMd).not.toContain('Lesson number 0 ')
  })
})
