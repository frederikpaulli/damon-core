import { expect, test } from 'vitest'
import { NATIVE_CLEANUP_UNCONFIRMED } from '../src/main/lib/providers/native-turn-supervisor'

test('the sentence says nobody needs to restart and the work should simply run again', () => {
  expect(NATIVE_CLEANUP_UNCONFIRMED).toMatch(/nobody needs to restart anything/)
  expect(NATIVE_CLEANUP_UNCONFIRMED).toMatch(/Run the same work again\.$/)
  expect(NATIVE_CLEANUP_UNCONFIRMED).not.toMatch(/needs recovery/)
})
