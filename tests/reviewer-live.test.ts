import { describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, TaskInfo } from '../src/shared/types'
import { makeAgentRun } from '../src/main/lib/agent-runner'
import { parseReviewVerdict, reviewerBrief } from '../src/shared/review'

const enabled = process.env['DAMON_SMOKE'] === '1'

const reviewer: AgentInfo = {
  id: 'r1',
  name: 'Reviewer',
  role: 'reads finished work',
  model: 'claude-sonnet-5',
  kind: 'agent',
  createdAt: new Date().toISOString()
}

const task = (title: string, acceptance: string): TaskInfo => ({
  id: 't1',
  agentId: 'a1',
  title,
  instructions: '',
  acceptance,
  status: 'reviewing',
  round: 1,
  feedback: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
})

const CRITERIA = 'The server refuses an order whose quantity is zero or negative, and works out the total from its own price list rather than from anything the browser sent.'

const SOUND = `const PRICES = { widget: 500, gadget: 1200 }

export function placeOrder(body) {
  const item = PRICES[body.item]
  if (!item) throw new Error('Unknown item')
  const qty = Number(body.quantity)
  if (!Number.isInteger(qty) || qty < 1) throw new Error('Bad quantity')
  return { total: item * qty }
}
`

const BROKEN = `const PRICES = { widget: 500, gadget: 1200 }

export function placeOrder(body) {
  const item = PRICES[body.item]
  if (!item) throw new Error('Unknown item')
  // Takes the quantity as given, and takes the unit price from the request.
  return { total: (body.unitPrice ?? item) * body.quantity }
}
`

async function review(source: string): Promise<{ satisfied: boolean; objections: string[]; text: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'damon-reviewlive-'))
  writeFileSync(join(dir, 'orders.js'), source, 'utf8')

  const brief = reviewerBrief({
    taskTitle: 'Order placement',
    criteria: CRITERIA,
    artifacts: [{ file: 'orders.js', how: 'written' }],
    round: 1,
    previousObjections: []
  })

  const outcome = await makeAgentRun(
    {
      cliPath: 'claude',
      cwd: dir,
      projectName: 'live',
      projectId: 'p1',
      skipPermissions: true,
      briefFor: () => brief,
      memoryOf: () => ({ agentMd: '', memoryMd: '', rejections: [] }),
      onNotes: () => {},
      timeoutMs: 4 * 60 * 1000
    },
    () => {}
  )(reviewer, task('Order placement', CRITERIA), null)

  const verdict = parseReviewVerdict(outcome.resultText)
  return { satisfied: verdict.satisfied, objections: verdict.objections, text: outcome.resultText }
}

describe.skipIf(!enabled)('the reviewer, live', () => {
  test(
    'it catches a real fault nobody told it about',
    async () => {
      const out = await review(BROKEN)
      expect(out.satisfied).toBe(false)
      expect(out.objections.join(' ').toLowerCase()).toMatch(/price|quantity|browser|request|body/)
    },
    5 * 60 * 1000
  )

  test(
    'it PASSES sound work, despite being told to assume the work is wrong',
    async () => {
      const out = await review(SOUND)
      expect(out.satisfied, `Reviewer invented a fault in sound work:\n${out.text}`).toBe(true)
    },
    5 * 60 * 1000
  )

  test(
    'it always answers in the block the gate can read',
    async () => {
      const out = await review(SOUND)
      expect(parseReviewVerdict(out.text).answered).toBe(true)
    },
    5 * 60 * 1000
  )
})
