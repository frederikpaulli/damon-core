import { describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeTurnSupervisor } from '../src/main/lib/providers/native-turn-supervisor'

const dir = (): string => mkdtempSync(join(tmpdir(), 'damon-recovery-'))

describe('when recovery cannot be verified', () => {
  test('the reason the cleanup proof gave is the reason the owner reads', async () => {
    const s = new NativeTurnSupervisor(dir())
    let said = ''
    try { await s.recover(async () => { throw Error('Native process cleanup is still unverified.') }) }
    catch (e) { said = e instanceof Error ? e.message : String(e) }
    expect(said, 'the refusal must still be plain').toMatch(/recovery is unverified/i)
    expect(said, 'and it must carry what actually went wrong').toContain('Native process cleanup is still unverified.')
    expect(said, 'and keep the honest line about no fallback').toMatch(/No new turn was admitted/)
  })

  test('a damaged journal says that instead, in its own words', async () => {
    const d = dir()
    writeFileSync(join(d, 'native-turns.json'), '{ this is not json', 'utf8')
    const s = new NativeTurnSupervisor(d)
    let said = ''
    try { await s.recover(async () => {}) } catch (e) { said = e instanceof Error ? e.message : String(e) }
    expect(said).toMatch(/recovery is unverified/i)
    expect(said.length).toBeGreaterThan('Native execution recovery is unverified. No new turn was admitted.'.length)
  })

  test('and a clean start still recovers silently', async () => {
    const s = new NativeTurnSupervisor(dir())
    await expect(s.recover(async () => {})).resolves.toBeUndefined()
    expect(s.status()).toMatchObject({ ready: true, held: false })
  })
})
