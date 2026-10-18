import { expect, it } from 'vitest'
import { directLineRefusal } from '../src/main/lib/task-admission'

const strict = { touchesPersonalData: true, noTrainingProviders: true }
const relaxed = { touchesPersonalData: false, noTrainingProviders: false }

it('on a client project, a brain the routing rule refuses is refused in the same words', () => {
  const said = directLineRefusal({ purpose: 'client', model: 'openai-gpt-5.5-high', name: 'Nils', handling: strict })
  expect(said).toMatch(/train/)
  expect(said).toMatch(/Nils/)
})

it('on a client project, a Claude brain passes; on a personal project nothing is gated', () => {
  expect(directLineRefusal({ purpose: 'client', model: 'claude-sonnet-5', name: 'Ada', handling: strict })).toBeUndefined()
  expect(directLineRefusal({ purpose: 'personal', model: 'openai-gpt-5.5-high', name: 'Nils', handling: strict })).toBeUndefined()
  expect(directLineRefusal({ purpose: 'client', model: 'openai-gpt-5.5-high', name: 'Nils', handling: relaxed })).toBeUndefined()
})
