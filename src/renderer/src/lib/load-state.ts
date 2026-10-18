import { errorText } from './error-text'

export type Load<T> = { phase: 'loading' } | { phase: 'ready'; value: T } | { phase: 'failed'; error: string }

export type Settled<T> = Exclude<Load<T>, { phase: 'loading' }>

export const LOADING: Load<never> = { phase: 'loading' }

export async function settle<T>(read: () => Promise<T>, fallback: string): Promise<Settled<T>> {
  try {
    return { phase: 'ready', value: await read() }
  } catch (e) {
    return { phase: 'failed', error: errorText(e, fallback) }
  }
}

export type Shelf = 'loading' | 'ready' | { failed: string }
export const shelfAfter = (was: Shelf, outcome: { error: string } | null): Shelf =>
  outcome === null ? 'ready' : was === 'ready' ? was : { failed: outcome.error }

export const keepLastGood = <T,>(last: { key: string; value: T } | null, key: string): T | null => (last && last.key === key ? last.value : null)
