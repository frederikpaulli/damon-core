import { nativeTurnTransport } from '../src/main/lib/providers/native-turn-transport'
import { expect, it } from 'vitest'

it('a factory that throws before the turn starts puts its reason in the result', async () => {
  const native = nativeTurnTransport(() => { throw Error('writes must name files, not a folder: drafts/x/') })
  const events: string[] = []
  native.process.stdout.on('data', chunk => events.push(chunk.toString()))
  native.process.stdin.write('prompt'); native.process.stdin.end()
  const result = await native.closed
  expect(result.ok).toBe(false)
  expect(result.error).toMatch(/could not start/)
  expect(result.error).toMatch(/writes must name files/)
})
