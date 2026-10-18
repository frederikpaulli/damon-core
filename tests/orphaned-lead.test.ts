import { describe, expect, test } from 'vitest'
import {
  isOrphanedLead,
  liveWorkUnder,
  orphanedLeads,
  orphanHandoverPrompt,
  orphanNotice,
  type Job,
  type Person
} from '../src/shared/chain-of-command'

const LEAD: Person = { id: 'lead-1', name: 'Backend and Data Lead', kind: 'submanager' }
const WORKER: Person = { id: 'eng-1', name: 'Sign-in and Groups Engineer', kind: 'agent', parentId: 'lead-1' }
const OTHER_LEAD: Person = { id: 'lead-2', name: 'Content and Deck Lead', kind: 'submanager' }
const PEOPLE = [LEAD, WORKER, OTHER_LEAD]

describe('whether the boss a report is going to can actually answer', () => {
  test('a lead leading its slice can', () => {
    const jobs: Job[] = [
      { agentId: 'lead-1', status: 'working' },
      { agentId: 'eng-1', status: 'queued' }
    ]
    expect(isOrphanedLead('lead-1', PEOPLE, jobs)).toBe(false)
  })

  test('a lead whose own assignment was failed by a restart cannot', () => {
    const jobs: Job[] = [
      { agentId: 'lead-1', status: 'failed' },
      { agentId: 'eng-1', status: 'queued' }
    ]
    expect(isOrphanedLead('lead-1', PEOPLE, jobs)).toBe(true)
  })

  test('an assignment that is finished business does not count as a channel', () => {
    const jobs: Job[] = [
      { agentId: 'lead-1', status: 'approved' },
      { agentId: 'eng-1', status: 'queued' }
    ]
    expect(isOrphanedLead('lead-1', PEOPLE, jobs)).toBe(true)
  })

  test('the grand-manager is never orphaned, because the chat is not a task', () => {
    expect(isOrphanedLead('root', PEOPLE, [])).toBe(false)
    expect(isOrphanedLead(undefined, PEOPLE, [])).toBe(false)
  })

  test('a plain agent is not a boss and is not judged as one', () => {
    const jobs: Job[] = [{ agentId: 'eng-1', status: 'failed' }]
    expect(isOrphanedLead('eng-1', PEOPLE, jobs)).toBe(false)
  })

  test('a boss who is no longer on the roster counts as unreachable', () => {
    expect(isOrphanedLead('someone-deleted', PEOPLE, [])).toBe(true)
  })
})

describe('how much is actually stuck behind it', () => {
  test('counts only unfinished work, and only its own team', () => {
    const jobs: Job[] = [
      { agentId: 'eng-1', status: 'queued' },
      { agentId: 'eng-1', status: 'review' },
      { agentId: 'eng-1', status: 'approved' },
      { agentId: 'eng-1', status: 'failed' },
      { agentId: 'other-team-member', status: 'queued' }
    ]
    expect(liveWorkUnder('lead-1', PEOPLE, jobs)).toBe(2)
  })
})

describe('the sweep that finds them at launch', () => {
  test('finds a lead holding live work with no assignment', () => {
    const jobs: Job[] = [
      { agentId: 'lead-1', status: 'failed' },
      { agentId: 'eng-1', status: 'queued' }
    ]
    expect(orphanedLeads(PEOPLE, jobs).map((p) => p.id)).toEqual(['lead-1'])
  })

  test('says nothing about a lead whose team has nothing left to do', () => {
    const jobs: Job[] = [
      { agentId: 'lead-1', status: 'approved' },
      { agentId: 'eng-1', status: 'approved' }
    ]
    expect(orphanedLeads(PEOPLE, jobs)).toEqual([])
  })

  test('says nothing about a healthy fleet', () => {
    const jobs: Job[] = [
      { agentId: 'lead-1', status: 'working' },
      { agentId: 'eng-1', status: 'working' }
    ]
    expect(orphanedLeads(PEOPLE, jobs)).toEqual([])
  })
})

describe('what gets said about it', () => {
  test('the grand-manager is told it is permanent, not a retry', () => {
    const said = orphanHandoverPrompt('Backend and Data Lead', 2)
    expect(said).toContain('Backend and Data Lead')
    expect(said).toContain('2 jobs')
    expect(said).toMatch(/never will|cannot fix|not something it can fix/i)
    expect(said).toMatch(/do not simply wait/i)
  })

  test('the owner is told plainly, and told the work is not lost', () => {
    const said = orphanNotice('Backend and Data Lead', 1)
    expect(said).toContain('Backend and Data Lead')
    expect(said).toMatch(/a job/)
    expect(said).toMatch(/nothing that was finished is lost/i)
    expect(said).not.toMatch(/assignment id|submanager|status|null/i)
  })
})
