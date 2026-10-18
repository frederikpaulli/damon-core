import { fileRole, type RoleContext } from './file-role'
import { narrowingArgs, runnerStages } from './check-receipt'

export type CodeRole = 'backend' | 'frontend' | 'tests' | 'contract' | 'migration' | 'config' | 'docs' | 'other'
export type Sensitive = 'money' | 'privacy' | 'security' | 'migration' | 'contract'
export interface UiRoot { dir: string; mixed: boolean }
export interface CodeContext extends RoleContext {
  backendRoots?: readonly string[]
  uiRoots?: readonly UiRoot[]
}

const norm = (p: string): string => (p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
const under = (p: string, dir: string): boolean => {
  const d = norm(dir).replace(/\/+$/, '').toLowerCase()
  return d === '' || p.toLowerCase().startsWith(d + '/')
}

const BACKEND_EXT = /\.(rs|go|py|java|kt|kts|scala|cs|fs|rb|php|ex|exs|erl|c|cc|cpp|h|hpp|swift|m|mm|sql|prisma)$/i
const SCREEN_EXT = /\.(tsx|jsx|vue|svelte|astro|mdx|css|scss|sass|less|html?)$/i
const SCRIPT_EXT = /\.(ts|mts|cts|js|mjs|cjs)$/i
const ASSET_EXT = /\.(svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|json)$/i
const SERVER_DIR = /(^|\/)(server|servers|api|backend|functions|lambdas?|workers?|main|preload|electron|cli|bin|scripts|db|database|jobs|cron)\//i
const SCREEN_DIR = /(^|\/)(renderer|client|web|frontend|ui|components|screens|pages|views|routes|layouts|styles|theme|design-system|i18n|locales)\//i
const MIGRATION = /(^|\/)migrations?\/|(^|\/)[^/]*migration[^/]*\.[a-z0-9]+$/i
const CONFIG = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|cargo\.(toml|lock)|tauri\.conf\.json|tsconfig[^/]*\.json|(vite|vitest|webpack|rollup|next|nuxt|svelte|astro|tailwind|postcss)\.config\.[cm]?[jt]s|go\.(mod|sum)|pyproject\.toml|requirements[^/]*\.txt|build\.gradle(\.kts)?|pom\.xml|build\.rs|config\.toml)$/i

const SERVER_FILE = /(^|\/)\+(?:page\.|layout\.)?server\.[cm]?[jt]s$|\.server\.[cm]?[jt]sx?$|(^|\/)app\/(?:.*\/)?route\.[cm]?[jt]s$/i
const USE_SERVER = /^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*['"]use server['"]/

function placeOf(p: string, ctx: CodeContext): { side: 'backend' | 'frontend' | 'other'; unplaced: boolean } {
  const at = (side: 'backend' | 'frontend' | 'other', unplaced = false) => ({ side, unplaced })
  if (BACKEND_EXT.test(p)) return at('backend')
  if (SERVER_FILE.test(p)) return at('backend')
  if ((ctx.backendRoots ?? []).some((d) => !!norm(d) && under(p, d))) return at('backend')
  const ui = (ctx.uiRoots ?? []).filter((r) => under(p, r.dir))
  const screenDir = SCREEN_DIR.test(p)
  const serverDir = SERVER_DIR.test(p)
  if (SCREEN_EXT.test(p)) return at(serverDir && !screenDir ? 'backend' : 'frontend')
  if (SCRIPT_EXT.test(p) || ASSET_EXT.test(p)) {
    if (serverDir) return at('backend')
    if (screenDir && ui.length) return at('frontend')
    if (ui.some((r) => !r.mixed)) return at('frontend')
    return SCRIPT_EXT.test(p) ? at('backend', ui.some((r) => r.mixed)) : at('other')
  }
  return at('other')
}
function sideOf(p: string, ctx: CodeContext): 'backend' | 'frontend' | 'other' {
  return placeOf(p, ctx).side
}
export function unplaced(path: string, ctx: CodeContext = {}): boolean {
  const p = norm(path)
  return !!p && placeOf(p, ctx).unplaced
}

export function codeRole(path: string, ctx: CodeContext = {}): CodeRole {
  const p = norm(path)
  if (!p) return 'other'
  const role = fileRole(p, ctx)
  if (role === 'evidence' || role === 'view') return 'docs'
  if (role === 'tests') return 'tests'
  if (MIGRATION.test(p) && !/\.(md|markdown|txt)$/i.test(p)) return 'migration'
  if (role === 'contract') return 'contract'
  if (CONFIG.test(p)) return 'config'
  if (role === 'outward' || role === 'owner-sheet' || role === 'record' || role === 'internal-doc') return 'docs'
  return sideOf(p, ctx)
}

export function areaPath(area: string): string {
  const a = norm(area)
  if (!/[*?]/.test(a)) return a
  const ext = /\*\.([a-z0-9]+)$/i.exec(a)?.[1]
  const dir = a.replace(/\/?\*\*?(?:\/.*)?$/, '').replace(/\/[^/]*[*?][^/]*$/, '')
  return `${dir ? dir + '/' : ''}x.${ext ?? 'ts'}`
}

const words = (p: string): string[] => norm(p).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9æøå]+/).filter(Boolean)
const MONEY = /^(?:money|pay|pays|paid|payment|payments|payout|payouts|payroll|invoice|invoices|invoicing|billing|bill|bills|ledger|ledgers|accounting|bookkeeping|tax|taxes|vat|moms|price|prices|pricing|fee|fees|rent|rents|leje|bank|banking|cash|cashflow|loan|loans|mortgage|mortgages|interest|currency|currencies|amount|amounts|salary|salaries|wage|wages|budget|budgets|finance|finances|financial|transaction|transactions|balance|balances|refund|refunds|depreciation|valuation|valuations|yield|expense|expenses|udgift|udgifter|income|revenue|profit|deposit|deposits|depositum)$/
const PRIVACY = /^(?:privacy|gdpr|personal|consent|consents|cpr|ssn|pii|tenant|tenants|lejer|lejere|customer|customers|contact|contacts|address|addresses|email|emails|phone|identity)$/
const SECURITY = /^(?:auth|authn|authz|login|logins|logout|password|passwords|secret|secrets|token|tokens|crypto|encrypt|encryption|decrypt|permission|permissions|session|sessions|credential|credentials|oauth|keychain|keyring|signature|signing)$/

const CURRENCY = /\b(?:DKK|EUR|USD|GBP|SEK|NOK|CHF)\b|\bkr\.?\s?\d|\d[\d.,]*\s?kr\b|\d,-(?=[\s'"<]|$)|[€£]\s?\d|\$\d{1,3}(?:,\d{3})*\.\d{2}\b|\bcurrency\s*[:=]|\bstyle\s*:\s*['"]currency['"]/
const AMOUNT_NAMES = /^(?:amount|amounts|price|prices|vat|moms|invoice|invoices|ledger|rent|rents|salary|salaries|payment|payments|fee|fees|balance|balances|currency|leje|depositum|udgift|udgifter)$/
const PERSONAL = /\b(?:cpr|cpr-?nr|ssn|social security|personnummer|national id|passport|gdpr|consent|date of birth|birth ?date|f[øo]dselsdato|tenant|tenants|lejer|lejere)\b/i
export function sensitiveInText(text: string): Sensitive[] {
  const t = (text ?? '').slice(0, 200_000)
  if (!t) return []
  const out: Sensitive[] = []
  const names = new Map<string, number>()
  for (const w of words(t)) if (AMOUNT_NAMES.test(w)) names.set(w, (names.get(w) ?? 0) + 1)
  const amountUses = [...names.values()].reduce((n, c) => n + c, 0)
  if (CURRENCY.test(t) || amountUses >= 2) out.push('money')
  if (PERSONAL.test(t)) out.push('privacy')
  return out
}

export interface ChangeClass {
  roles: Partial<Record<CodeRole, string[]>>
  backend: boolean
  frontend: boolean
  visual: boolean
  sharedVisual: boolean
  docsOnly: boolean
  sensitive: Sensitive[]
}

const SHARED_UI = /(^|\/)(design-system|styles?|theme|themes|tokens?|shell|layouts?)\/|(^|\/)(index|app|global|globals|main|tokens?|theme)\.(css|scss|sass|less)$|(^|\/)tokens?\.[cm]?[jt]s$/i

export function changeClass(paths: readonly string[], ctx: CodeContext = {}, textOf?: (path: string) => string | undefined): ChangeClass {
  const roles: Partial<Record<CodeRole, string[]>> = {}
  const sensitive = new Set<Sensitive>()
  const hasUi = (ctx.uiRoots?.length ?? 0) > 0
  let backend = false, frontend = false, visual = false, sharedVisual = false
  const files = [...new Set(paths.map((p) => (/[*?]/.test(p) ? areaPath(p) : norm(p))).filter(Boolean))]
  for (const f of files) {
    let text: string | undefined
    try { text = textOf?.(f) } catch { text = undefined }
    let role = codeRole(f, ctx)
    if ((role === 'frontend' || role === 'backend') && text && USE_SERVER.test(text.slice(0, 4000))) role = 'backend'
    ;(roles[role] ??= []).push(f)
    if (role === 'docs') continue
    if (role === 'frontend') { frontend = true; visual = true; if (SHARED_UI.test(f)) sharedVisual = true }
    else if (role === 'tests') { if (sideOf(f, ctx) === 'frontend') frontend = true; else backend = true }
    else if (role === 'contract') { backend = true; frontend = frontend || hasUi; sensitive.add('contract') }
    else if (role === 'migration') { backend = true; sensitive.add('migration') }
    else if (role === 'config') { backend = true; frontend = frontend || hasUi }
    else {
      backend = true
      if (role === 'backend' && unplaced(f, ctx) && !(text && USE_SERVER.test(text.slice(0, 4000)))) frontend = true
    }
    const w = words(f)
    if (w.some((x) => MONEY.test(x))) sensitive.add('money')
    if (w.some((x) => PRIVACY.test(x))) sensitive.add('privacy')
    if (w.some((x) => SECURITY.test(x))) sensitive.add('security')
    if (text) for (const s of sensitiveInText(text)) sensitive.add(s)
  }
  const order: Sensitive[] = ['money', 'privacy', 'security', 'migration', 'contract']
  return { roles, backend, frontend, visual, sharedVisual, docsOnly: files.length > 0 && files.every((f) => codeRole(f, ctx) === 'docs'), sensitive: order.filter((s) => sensitive.has(s)) }
}

export interface CheckPlan {
  backend: 'full' | 'none'
  frontend: 'full' | 'related' | 'none'
  visual: 'careful' | 'none'
  lookEverywhere: boolean
  scrutiny: 'deep' | 'standard'
  reasons: string[]
  jsSuite?: boolean
}

const few = (xs: readonly string[] = []): string => xs.slice(0, 3).join(', ') + (xs.length > 3 ? ` and ${xs.length - 3} more` : '')

export function checkPlan(c: ChangeClass): CheckPlan {
  if (c.docsOnly) return { backend: 'none', frontend: 'none', visual: 'none', lookEverywhere: false, scrutiny: 'standard', reasons: ['only documents changed, so no build or test can find anything in this change'] }
  const reasons: string[] = []
  const backendFiles = [...(c.roles.backend ?? []), ...(c.roles.migration ?? []), ...(c.roles.contract ?? []), ...(c.roles.config ?? []), ...(c.roles.other ?? [])]
  if (c.backend) reasons.push(backendFiles.length ? `backend code changed (${few(backendFiles)})` : 'backend tests changed')
  else reasons.push('no backend file changed, so a backend build and its suite cannot find anything in this change')
  const wide = c.sensitive.length > 0 || c.sharedVisual || !!c.roles.contract?.length || !!c.roles.config?.length
  const frontend: CheckPlan['frontend'] = !c.frontend ? 'none' : wide ? 'full' : 'related'
  if (frontend !== 'none') reasons.push(frontend === 'full' ? 'screen code changed where it matters most (money, privacy, security, a contract, a config or something every screen shares), so every screen test runs' : 'screen code changed, so the screens are built and their tests for what changed run')
  if (c.visual) reasons.push(c.sharedVisual ? 'something every screen shares changed, so every place gets a careful look' : 'something on screen can look different, so it gets a careful look')
  if (c.sensitive.length) reasons.push(`it touches ${c.sensitive.join(', ')}`)
  return { backend: c.backend ? 'full' : 'none', frontend, visual: c.visual ? 'careful' : 'none', lookEverywhere: c.sharedVisual, scrutiny: c.backend || c.sensitive.length ? 'deep' : 'standard', reasons }
}

export function recheckPlan(input: { whole: ChangeClass; changed: ChangeClass; last: { at?: string; plan?: CheckPlan; missing?: string[]; careful?: { needed: boolean; done: boolean }; standsOn?: { receipt: string; round: number; commands: string[] }; receipts?: number } | null; landedSince: boolean }): CheckPlan {
  const full = checkPlan(input.whole)
  const last = input.last
  if (!last?.plan || input.landedSince) return { ...full, reasons: [...full.reasons, input.landedSince ? 'something landed in the project since the last review, so every check runs again' : 'the last review left no record of its checks, so every check runs'] }
  const now = input.changed.roles && Object.keys(input.changed.roles).length ? checkPlan(input.changed) : { backend: 'none' as const, frontend: 'none' as const, visual: 'none' as const, lookEverywhere: false, scrutiny: 'standard' as const, reasons: ['nothing changed since the last review'] }
  const missing = last.missing ?? []
  const reasons = [...now.reasons]
  let backend = now.backend
  if (input.whole.backend && backend === 'none') {
    const ranThen = last.plan.backend === 'full' && !missing.includes('the whole backend test suite')
    const ran = last.receipts === 562 && (ranThen || !!last.standsOn)
    if (ran && !ranThen && last.standsOn) reasons.push(`no backend file changed since the run of ${last.standsOn.receipt} (round ${last.standsOn.round}), which ran the whole backend suite and which the last review stood on: that run stands`)
    else if (ran) reasons.push(`no backend file changed since the last review${last.at ? ` (${last.at})` : ''}, which ran the whole backend suite: that run stands`)
    else { backend = 'full'; reasons.push('no backend file changed since the last review, but it did not run the whole backend suite, so it runs now') }
  }
  let frontend = now.frontend
  if (input.whole.frontend && frontend === 'none') {
    const ran = last.plan.frontend !== 'none' && !missing.some((m) => /screens/.test(m))
    if (!ran) { frontend = full.frontend; reasons.push('no screen file changed since the last review, but it did not run the screen checks, so they run now') }
  }
  let visual = now.visual
  if (input.whole.visual && visual === 'none') {
    if (last.careful?.done) reasons.push('no screen changed since the last review, which looked at every picture with care: that look stands')
    else { visual = 'careful'; reasons.push('no screen changed since the last review, but it did not finish its careful look, so it looks now') }
  }
  return { backend, frontend, visual, lookEverywhere: now.lookEverywhere || (visual === 'careful' && full.lookEverywhere && !last.careful?.done), scrutiny: backend === 'full' || input.changed.backend || input.changed.sensitive.length ? 'deep' : 'standard', reasons }
}

export interface CheckCommands { backendSuite: string[]; frontendBuild: string[]; frontendRelated: string[]; frontendFull: string[] }

const BACKEND_SUITE = /(?:^|[\s;&|(])(cargo\s+(?:test|nextest\s+run)|go\s+test|pytest|python3?\s+-m\s+(?:pytest|unittest)|dotnet\s+test|mvn(?:\s+\S+)*?\s+test|(?:\.\/)?gradlew?\s+test|mix\s+test|(?:bundle\s+exec\s+)?rspec|phpunit|ctest)\b([^;&|]*)/i
const JS_SUITE = /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)(?:\s+--prefix\s+\S+)?\s+(?:run\s+)?test\b([^;&|]*)|(?:(?:npx|bunx|yarn|pnpm(?:\s+exec)?)\s+)?(vitest(?:\s+(?:run|related))?|jest)\b([^;&|]*))/i
const FRONTEND_BUILD = /(?:^|[\s;&|(])(?:(?:npx|bunx|yarn|pnpm(?:\s+exec)?)\s+)?(?:tsc|vue-tsc|svelte-check|vite\s+build|ng\s+build)\b|(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)(?:\s+--prefix\s+\S+)?\s+(?:run\s+)?(?:build|typecheck|type-check|check|tsc)\b/i
const FRONTEND_TESTS = /(?:^|[\s;&|(])(?:(?:npx|bunx|yarn|pnpm(?:\s+exec)?)\s+)?(vitest(?:\s+(?:run|related))?|jest|playwright\s+test)\b([^;&|]*)|(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)(?:\s+--prefix\s+\S+)?\s+(?:run\s+)?test\b([^;&|]*)/i
const bareArgs = (rest: string): string[] => narrowingArgs(rest)
const jsWhole = (c: string): boolean => {
  const m = JS_SUITE.exec(c)
  if (!m || m.index !== 0) return false
  if (/related/i.test(m[2] ?? '') || /--findRelatedTests|--related/.test(m[0])) return false
  return bareArgs(m[1] ?? m[3] ?? '').length === 0
}

const stageKey = (s: string): string => s.replace(/(?:^|\s)(?:\d|&)?>>?&?\s*\S+/g, ' ').trim().replace(/\s+/g, ' ')
const at0 = (re: RegExp, s: string): RegExpExecArray | null => { const m = re.exec(s); return m && m.index === 0 ? m : null }
export function missingChecks(plan: CheckPlan, ranAsTyped: readonly string[], aliases: Readonly<Record<string, string>> = {}): string[] {
  const ran = ranAsTyped.flatMap((c) => {
    const typed = (c ?? '').trim().replace(/\s+/g, ' ')
    const stages = runnerStages(typed)
    const expanded = [typed, ...stages].flatMap((s) => { const body = aliases[s] ?? aliases[stageKey(s)]; return body ? runnerStages(body) : [] })
    return [...stages, ...expanded]
  })
  const out: string[] = []
  const backendWhole = (c: string): boolean => { const m = at0(BACKEND_SUITE, c ?? ''); return (!!m && bareArgs(m[2] ?? '').length === 0) || (!!plan.jsSuite && jsWhole(c ?? '')) }
  if (plan.backend === 'full' && !ran.some(backendWhole)) out.push('the whole backend test suite')
  if (plan.frontend !== 'none') {
    if (!ran.some((c) => !!at0(FRONTEND_BUILD, c ?? ''))) out.push('a build or type check of the screens')
    const tests = ran.map((c) => at0(FRONTEND_TESTS, c ?? '')).filter((m): m is RegExpExecArray => !!m)
    const full = tests.some((m) => !/related/i.test(m[1] ?? '') && !/--findRelatedTests|--related/.test(m[0]) && bareArgs(m[2] ?? m[3] ?? '').length === 0)
    if (!tests.length) out.push(plan.frontend === 'full' ? "every one of the screens' tests" : "the screens' tests")
    else if (plan.frontend === 'full' && !full) out.push("every one of the screens' tests")
  }
  return out
}

const DEEP: Record<Sensitive | 'backend', string> = {
  backend: 'Read every changed line of logic, and try the failure cases the criteria do not name (empty, zero, very large, wrong order, twice).',
  money: 'Money: recompute at least two figures by hand from the test or sample data and compare; check rounding, signs, currency and dates at the edges (month ends, zero, negative, a part payment, a charge over several months).',
  privacy: 'Personal data: trace where each personal field is stored, shown, logged and sent; nothing leaves the machine or reaches a log unless the job says so.',
  security: 'Sign-in, secrets and permissions: try the wrong user, no user and an expired session, and look for a secret in a log or a file.',
  migration: 'A migration: run it on a copy of a database that already holds data, check every row survives and the app still opens it, and that it runs once.',
  contract: 'A contract: every caller on both sides still matches it.'
}

export function planBrief(plan: CheckPlan, cls: ChangeClass, cmds: Partial<CheckCommands> = {}, who: 'reviewer' | 'worker' = 'reviewer', opts: { projectCheck?: boolean; suiteDone?: boolean; damonRunsSuite?: boolean } = {}): string {
  const files = (cls.roles.frontend ?? []).concat(cls.roles.tests ?? []).join(' ')
  const say = (xs: string[] | undefined): string => (xs?.length ? `: ${xs.map((x) => x.replace('{files}', files || '<the changed files>')).join(' ; ')}` : '')
  const need: string[] = []
  const suiteDone = who === 'reviewer' && plan.backend === 'full' && !!opts.suiteDone
  const damonRuns = who === 'worker' && !!opts.damonRunsSuite
  if (suiteDone) need.push('- The whole backend test suite: already run by Damon on this draft, and it passed (see FULL SUITE RECEIPT below). It counts here; do not run it again.')
  else if (damonRuns && plan.backend === 'full') need.push('- The tests for what you changed. Damon runs the whole backend test suite on your finished draft before the review, so you do not run it yourself.')
  else if (plan.backend === 'full') need.push(`- The whole backend test suite, once, unfiltered (it builds the backend too)${say(cmds.backendSuite)}. Run it once rather than test by test: a run of some tests is not the suite.`)
  if (plan.frontend !== 'none') {
    need.push(`- A build or type check of the screens${say(cmds.frontendBuild)}.`)
    need.push(plan.frontend === 'full' ? `- Every one of the screens' tests${say(cmds.frontendFull)}.` : `- The screens' tests for what changed${say(cmds.frontendRelated)}.`)
  }
  if (plan.visual === 'careful') need.push(plan.lookEverywhere ? '- A careful look at EVERY place the project names (something every screen shares changed), at phone and desktop width, in light and dark (see THE CAREFUL LOOK).' : '- A careful look at every changed screen, at phone and desktop width, in light and dark (see THE CAREFUL LOOK).')
  const toRun = plan.frontend !== 'none' ? 2 : 0
  const lines = [`THE CHECKS THIS CHANGE NEEDS (Damon read them from the files it changed: ${plan.reasons.join('; ')}).`]
  lines.push(need.length ? (who === 'reviewer' ? (suiteDone && need.length === 1 ? 'Damon has already run what this change needs:' : 'Run at least these in this review and quote their real output:') : 'Run these yourself before you report finished; they are what your reviewer runs:') : 'No build or test can find anything in this change; read every file, and look at any page as the brief says.')
  lines.push(...need)
  if (who === 'worker') lines.push(damonRuns
    ? 'These are worked out from where you may write. If you end up changing a backend file, a contract, a schema, a migration or a config, run its targeted tests and every screen test too; Damon runs the whole backend test suite on your finished draft for the review.'
    : 'These are worked out from where you may write. If you end up changing a backend file, a contract, a schema, a migration or a config, run the whole backend suite and every screen test too: your reviewer will.')
  if (plan.backend === 'none' && !plan.reasons[0]?.startsWith('only documents')) lines.push('Not needed: the backend build and its suite. No backend file changed, so they cannot find anything here; run them only if a criterion about a changed file needs it, and say why.')
  if (plan.scrutiny === 'deep') lines.push(`READ IT DEEPLY. ${[...(cls.backend ? [DEEP.backend] : []), ...cls.sensitive.map((s) => DEEP[s])].join(' ')}`)
  if (who === 'reviewer') lines.push(suiteDone ? 'You may run more than this, never less: Damon refuses a "meets" until each check above has run in this review (Damon\'s own run of the whole suite on this draft counts).' : 'You may run more than this, never less: Damon refuses a "meets" until each check above has run in this review.')
  if (who === 'reviewer' && (suiteDone ? toRun > 0 : need.length > 0)) lines.push(`${opts.projectCheck ? 'Run the required suite with run_project_check; a shell run' : 'A run'} counts only if its own output proves it: the runner last in the command, or ; echo "exit=$?" right after it, or its full summary unfiltered (a log it wrote counts when you read it back in this review).${opts.projectCheck ? ' If a criterion is unproven only because the worker did not show a run, run it yourself with run_project_check and judge the result; never send work back for evidence you can produce.' : ''}`)
  return lines.join('\n')
}
