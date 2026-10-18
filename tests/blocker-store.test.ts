import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alreadyConnected, BlockerStore, matchesConnection } from '../src/main/lib/blocker-store'

const dir = (): string => mkdtempSync(join(tmpdir(), 'damon-test-'))

describe('matchesConnection', () => {
  test('the manager asking for a service meets the connection that provides it', () => {
    expect(matchesConnection('Mailchimp', 'Mailchimp')).toBe(true)
    expect(matchesConnection('Mailchimp', 'Mailchimp (email campaigns)')).toBe(true)
    expect(matchesConnection('your Google Drive account', 'Google Drive')).toBe(true)
    expect(matchesConnection('a web browser', 'Web browser (Chrome)')).toBe(true)
  })

  test('unrelated things do not meet', () => {
    expect(matchesConnection('Mailchimp', 'Google Drive')).toBe(false)
    expect(matchesConnection('', 'Google Drive')).toBe(false)
    expect(matchesConnection('Shopify', '')).toBe(false)
  })
})

describe('BlockerStore', () => {
  test('records what is needed, why, and who is held up', () => {
    const store = new BlockerStore(dir())
    const b = store.add('Mailchimp', 'to read the campaign stats', 'Content Writer')
    expect(b.what).toBe('Mailchimp')
    expect(store.open()).toHaveLength(1)
  })

  test('asking twice for the same thing is not two problems', () => {
    const store = new BlockerStore(dir())
    const first = store.add('Mailchimp', 'to read the stats', 'Content Writer')
    const again = store.add('Mailchimp (email)', 'to read the stats again', 'Content Writer')
    expect(again.id).toBe(first.id)
    expect(store.open()).toHaveLength(1)
    store.add('Mailchimp', 'to send the draft', 'Campaign Builder')
    expect(store.open()).toHaveLength(2)
  })

  test('connecting the thing clears everything waiting on it, and only that', () => {
    const store = new BlockerStore(dir())
    store.add('Mailchimp', 'stats', 'A')
    store.add('Google Drive', 'the brief', 'B')
    const freed = store.resolveFor('Mailchimp')
    expect(freed).toHaveLength(1)
    expect(store.open().map((b) => b.what)).toEqual(['Google Drive'])
    expect(store.resolveFor('Mailchimp')).toEqual([])
  })

  test('the owner can wave one away without connecting anything', () => {
    const store = new BlockerStore(dir())
    const b = store.add('Mailchimp', 'stats')
    expect(store.dismiss(b.id)).toEqual([])
  })
})

describe('alreadyConnected', () => {
  const connections = [
    { name: 'Web browser (Chrome)', enabled: true },
    { name: 'Mailchimp', enabled: false },
    { name: 'Perplexity research', enabled: true }
  ]

  test('the owner is not asked for something they already switched on', () => {
    expect(alreadyConnected('a web browser', connections)?.name).toBe('Web browser (Chrome)')
  })

  test('something switched OFF still counts as not connected', () => {
    expect(alreadyConnected('Mailchimp', connections)).toBeUndefined()
  })

  test('something genuinely missing is still missing', () => {
    expect(alreadyConnected('your Shopify shop', connections)).toBeUndefined()
  })
})
