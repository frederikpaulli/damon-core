import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskEngine } from '../src/main/lib/task-engine'
import type { AgentInfo, TaskInfo } from '../src/shared/types'

const PEOPLE: Record<string, AgentInfo> = {
  backend: { id: 'backend', name: 'Backend and Data Lead', role: 'data', model: 'claude-sonnet-5', kind: 'agent', createdAt: 'x' },
  content: { id: 'content', name: 'Content and Deck Lead', role: 'words', model: 'claude-sonnet-5', kind: 'agent', createdAt: 'x' },
  schema: { id: 'schema', name: 'Database Schema Engineer', role: 'schema', model: 'claude-sonnet-5', kind: 'agent', createdAt: 'x' }
}

function engine(): TaskEngine {
  const roster = {
    get: (id: string): AgentInfo | undefined => PEOPLE[id]
  } as unknown as ConstructorParameters<typeof TaskEngine>[1]
  return new TaskEngine(
    mkdtempSync(join(tmpdir(), 'damon-spine-')),
    roster,
    () => new Promise(() => {}) as never,
    { onTaskUpdate: () => {}, onAgentReport: () => {} }
  )
}

function put(e: TaskEngine, ...args: Parameters<TaskEngine['assign']>): TaskInfo {
  const r = e.assign(...args)
  if ('error' in r) throw new Error(r.error)
  return r
}

const waitingReason = (e: TaskEngine, taskId: string): string | undefined =>
  e.list().find((t) => t.id === taskId)?.waitingFor

describe('work that changes the shape of the stored information', () => {
  test('two of them never run at once, which is the whole point of the rule', async () => {
    const e = engine()
    const first = put(e, 'backend', 'Add the groups tables', 'do it', 'done', undefined, undefined, ['supabase/migrations/**'])
    const second = put(e, 'schema', 'Add the invites tables', 'do it', 'done', undefined, undefined, ['supabase/migrations/**'])
    await new Promise((r) => setTimeout(r, 20))

    expect(e.list().find((t) => t.id === first.id)?.status).toBe('working')
    expect(e.list().find((t) => t.id === second.id)?.status).toBe('queued')
    expect(waitingReason(e, second.id)).toBeTruthy()
  })

  test('does not hold up a job that shares no files with it', async () => {
    const e = engine()
    e.assign('backend', 'Add the groups tables', 'do it', 'done', undefined, undefined, ['apps/mobile/**', 'supabase/migrations/**'])
    await new Promise((r) => setTimeout(r, 20))

    const docs = put(e, 'content', 'Write up the deviations', 'do it', 'done', undefined, undefined, ['docs/deviations.md'])
    await new Promise((r) => setTimeout(r, 20))

    expect(e.list().find((t) => t.id === docs.id)?.status).toBe('working')
    expect(waitingReason(e, docs.id)).toBeFalsy()
  })

  test('a migration still waits while ordinary work is running', async () => {
    const e = engine()
    e.assign('content', 'Write up the deviations', 'do it', 'done', undefined, undefined, ['docs/deviations.md'])
    await new Promise((r) => setTimeout(r, 20))

    const migration = put(e, 'backend', 'Add the groups tables', 'do it', 'done', undefined, undefined, ['supabase/migrations/**'])
    await new Promise((r) => setTimeout(r, 20))

    expect(e.list().find((t) => t.id === migration.id)?.status).toBe('queued')
    expect(waitingReason(e, migration.id)).toBeTruthy()
  })

  test('a real file overlap is still caught, spine or no spine', async () => {
    const e = engine()
    e.assign('backend', 'Build the group screens', 'do it', 'done', undefined, undefined, ['apps/mobile/**'])
    await new Promise((r) => setTimeout(r, 20))

    const clashing = put(e, 'content', 'Also build the group screens', 'do it', 'done', undefined, undefined, ['apps/mobile/**'])
    await new Promise((r) => setTimeout(r, 20))

    expect(e.list().find((t) => t.id === clashing.id)?.status).toBe('queued')
    expect(waitingReason(e, clashing.id)).toBeTruthy()
  })

  test('the reason names the job it is actually waiting for', async () => {
    const e = engine()
    e.assign('backend', 'Add the groups tables', 'do it', 'done', undefined, undefined, ['supabase/migrations/**'])
    await new Promise((r) => setTimeout(r, 20))
    const second = put(e, 'schema', 'Add the invites tables', 'do it', 'done', undefined, undefined, ['supabase/migrations/**'])
    await new Promise((r) => setTimeout(r, 20))

    expect(waitingReason(e, second.id)).toContain('Add the groups tables')
  })
})
