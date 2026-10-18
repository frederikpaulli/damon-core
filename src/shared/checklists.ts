export interface ChecklistItem {
  id: string
  concern: string
  risk: string
  tests: string[]
}

export interface Checklist {
  id: string
  name: string
  signals: string[]
  items: ChecklistItem[]
}

export const CHECKLISTS: Checklist[] = [
  {
    id: 'software',
    name: 'Shipping something people use on a computer',
    signals: [
      'software',
      'app',
      'apps',
      'web app',
      'mobile app',
      'website',
      'web site',
      'api',
      'apis',
      'backend',
      'back end',
      'back-end',
      'frontend',
      'front end',
      'front-end',
      'database',
      'saas',
      'code',
      'codebase',
      'script',
      'deploy',
      'deployed',
      'deployment',
      'log in',
      'login',
      'sign up',
      'sign-up',
      'signup',
      'server',
      'browser extension',
      'plugin'
    ],
    items: [
      {
        id: 'screens',
        concern: 'The screens people actually see and use',
        risk: 'It works, and nobody can find their way around it.',
        tests: [
          'Open the five most important pages and take a screenshot of each. Keep them, so the next change can be compared against them and a silent rewrite of a page nobody was looking at is caught.',
          'Every screen a person can reach has a way back out of it that does not need the browser button.'
        ]
      },
      {
        id: 'engine',
        concern: 'What does the real work behind those screens',
        risk: 'The screens look finished and nothing happens when you press the button.',
        tests: [
          'Send a request straight to the server with a value the screen would never allow: wrong type, out of range, a required field missing, a price the client made up. The server rejects every one of them. Whatever the screen checks, the server checks again.',
          'If money changes hands: the amount is decided by the server from its own prices, never taken from what the browser sent, and any payment notification from outside is checked for a valid signature before it is believed.'
        ]
      },
      {
        id: 'data',
        concern: 'Where the information is kept, and what shape it is in',
        risk: 'Information gets saved in a way nobody can change later without losing it.',
        tests: [
          'Change something about the shape of the stored information and put it back again, on a copy. Nothing is lost either way.'
        ]
      },
      {
        id: 'permission',
        concern: 'Who is allowed to do what',
        risk: 'Anyone who finds the address can do anything.',
        tests: [
          'Every address the server answers on checks for itself who is asking and whether they are allowed. Hiding a button is not a control: call the address directly, signed in as somebody who should not be allowed, and it refuses.',
          'Signing in, staying signed in, resetting a forgotten password and two-factor are handled by something established rather than written here. Building your own is one of the most reliable ways to get this wrong, and the reason for any exception is written down.'
        ]
      },
      {
        id: 'hosting',
        concern: 'Where it runs, and how a new version gets there',
        risk: 'It only ever works on the machine it was built on.',
        tests: [
          'Start it from nothing on a machine that has never run it, following only the written instructions. It comes up.'
        ]
      },
      {
        id: 'running-cost',
        concern: 'What it runs on, and what that costs every month',
        risk: 'A bill arrives that nobody agreed to.',
        tests: [
          'Write down what it costs to run for a month at the size expected, and what it would cost at ten times that.'
        ]
      },
      {
        id: 'shipping',
        concern: 'How a change is checked before it reaches people',
        risk: 'A small fix quietly breaks something that used to work.',
        tests: [
          'Make a small change and confirm the checks run before it can reach anybody, and that a deliberately broken change is stopped by them.'
        ]
      },
      {
        id: 'separation',
        concern: "Keeping one person's information away from another's",
        risk: 'One customer sees another customer’s data.',
        tests: [
          'Make two accounts. Create something in the first. Signed in as the second, ask for that thing by its id. It is refused. This works far more often than anyone expects, so it is run rather than reasoned about.'
        ]
      },
      {
        id: 'flooding',
        concern: 'Stopping one user, or one mistake, from swamping the whole thing',
        risk: 'One runaway loop takes it down for everybody, or runs up the bill.',
        tests: [
          'Call a public address a few hundred times in a row from one place. It starts refusing. Anything public without this can be guessed at, scraped, or used to run up a bill.'
        ]
      },
      {
        id: 'speed',
        concern: 'Making it fast, without showing people out-of-date information',
        risk: 'It is either slow, or quick and wrong.',
        tests: [
          'Load the busiest page and time it. Then change something behind it and confirm the page shows the new version rather than a stale copy.'
        ]
      },
      {
        id: 'crowds',
        concern: 'What happens when far more people turn up than expected',
        risk: 'The day it gets popular is the day it stops working.',
        tests: [
          'Put ten times the expected traffic through the busiest path and record what happens. Slower is fine; falling over is the answer worth knowing before the day it gets popular.'
        ]
      },
      {
        id: 'alarms',
        concern: 'Finding out it broke without waiting for someone to complain',
        risk: 'It has been broken for two days and the first you hear of it is a user.',
        tests: [
          'Break something on purpose and confirm a report of it arrives somewhere a person will see, without anyone having to complain first. Users do not report bugs, they leave.'
        ]
      },
      {
        id: 'secrets',
        concern: 'Keys and passwords staying out of the code',
        risk: 'A key ends up in the code, gets published with it, and someone else uses your account.',
        tests: [
          'Search the whole project for sk-, secret, password, token and key. For every hit, say whether it is a real value or a stand-in. Real values do not stay in the code.',
          'Check that no settings file with real values is committed, and that the example one has stand-ins only.',
          'Check what the live version would use. A value that begins dev-only, test, changeme or localhost is right on a developer machine and a real failure in the live one, so anything that would ship with one is reported.'
        ]
      },
      {
        id: 'recovery',
        concern: 'Getting it back, with the information intact, after it goes down',
        risk: 'Something is deleted and there is no copy to put back.',
        tests: [
          'RESTORE from a backup, onto an empty place, and check the information is there and correct. The existence of a backup job is not the test. An untested backup is hope.'
        ]
      }
    ]
  }
]

export function checklist(id: string): Checklist | undefined {
  return CHECKLISTS.find((c) => c.id === id)
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

function mentions(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text)
}

export function checklistsFor(text: string): Checklist[] {
  const t = norm(text)
  return CHECKLISTS.filter((c) => c.signals.some((s) => mentions(t, s)))
}

export type Disposition = 'staffed' | 'owner' | 'excluded'

export interface Coverage {
  item: string
  how: Disposition
  who?: string
  why?: string
}

export interface CoverageVerdict {
  ok: boolean
  missing: ChecklistItem[]
  message: string
}

function findItem(items: ChecklistItem[], named: string): ChecklistItem | undefined {
  const n = norm(named)
  return items.find((it) => norm(it.id) === n || norm(it.concern) === n)
}

export function checkCoverage(
  lists: Checklist[],
  coverage: Coverage[] | undefined,
  people: string[]
): CoverageVerdict {
  const given = coverage ?? []
  const names = new Set(people.map((p) => norm(p)))
  const missing: ChecklistItem[] = []
  const problems: string[] = []

  for (const list of lists) {
    for (const item of list.items) {
      const said = given.find((c) => findItem(list.items, c.item)?.id === item.id)
      if (!said) {
        missing.push(item)
        continue
      }
      if (said.how === 'staffed') {
        const who = (said.who ?? '').trim()
        if (!who) {
          problems.push(`"${item.concern}" is marked as covered but nobody is named as covering it.`)
        } else if (!names.has(norm(who))) {
          problems.push(
            `"${item.concern}" is marked as covered by ${who}, and nobody on this chart is called ${who}. Name someone who is on it.`
          )
        }
        continue
      }
      if (!(said.why ?? '').trim()) {
        problems.push(
          said.how === 'excluded'
            ? `"${item.concern}" is being left out with no reason given. One line is enough, and the owner reads it.`
            : `"${item.concern}" is marked as the owner's decision with nothing said about what they are deciding.`
        )
      }
    }
  }

  if (missing.length === 0 && problems.length === 0) return { ok: true, missing: [], message: '' }

  const lines: string[] = ['Nothing was proposed. This job has a checklist and the chart does not answer all of it yet.']
  if (missing.length > 0) {
    lines.push('', 'Nothing was said about these:')
    for (const it of missing) lines.push(`- ${it.concern}. Left alone: ${it.risk}`)
  }
  if (problems.length > 0) {
    lines.push('', 'And these were answered, but not properly:')
    for (const p of problems) lines.push(`- ${p}`)
  }
  lines.push(
    '',
    'Call propose_team again with the whole chart and a coverage entry for every item. For each one: how "staffed" with who (a name on this chart, and one person can carry several), or how "owner" with why it is theirs to decide, or how "excluded" with one plain line saying why it does not apply here. Leaving something out is a fine answer; leaving it unsaid is not. Do not add a person per item: most jobs need a few people who each carry several of these.'
  )
  return { ok: false, missing, message: lines.join('\n') }
}

export function summariseCoverage(checklists: string[] | undefined, coverage: Coverage[] | undefined): string {
  const lists = (checklists ?? []).map((id) => checklist(id)).filter((c): c is Checklist => Boolean(c))
  const g = groupCoverage(lists, coverage)
  const total = lists.reduce((n, l) => n + l.items.length, 0)
  if (total === 0 || g.staffed.length + g.owner.length + g.excluded.length === 0) return ''
  const parts = [`${g.staffed.length} covered by the team`]
  if (g.owner.length > 0) parts.push(`${g.owner.length} for you to decide`)
  if (g.excluded.length > 0) parts.push(`${g.excluded.length} left out on purpose`)
  return `${total} things a job like this usually needs: ${parts.join(', ')}.`
}

export interface GroupedCoverage {
  staffed: { concern: string; who: string }[]
  owner: { concern: string; why: string }[]
  excluded: { concern: string; why: string }[]
}

export function groupCoverage(lists: Checklist[], coverage: Coverage[] | undefined): GroupedCoverage {
  const out: GroupedCoverage = { staffed: [], owner: [], excluded: [] }
  for (const list of lists) {
    for (const item of list.items) {
      const said = (coverage ?? []).find((c) => findItem(list.items, c.item)?.id === item.id)
      if (!said) continue
      if (said.how === 'staffed') out.staffed.push({ concern: item.concern, who: (said.who ?? '').trim() })
      else if (said.how === 'owner') out.owner.push({ concern: item.concern, why: (said.why ?? '').trim() })
      else out.excluded.push({ concern: item.concern, why: (said.why ?? '').trim() })
    }
  }
  return out
}
