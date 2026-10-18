import { z } from 'zod'

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, 'Use lower-case letters, digits and dashes.')
const words = z.string().trim().min(1).max(120)

export const metricShape = z.enum(['count', 'rate', 'series', 'status', 'money'])
export type MetricShape = z.infer<typeof metricShape>

export const metricView = z.enum(['planning', 'building', 'reviewing', 'releasing', 'live'])
export type MetricView = z.infer<typeof metricView>

export const metricSource = z.object({
  kind: z.enum(['damon', 'connection']),
  connectionId: z.string().trim().min(1).max(200).optional(),
  query: z.string().trim().min(1).max(500).optional()
}).strict()

export const metricDefinition = z.object({
  id: slug,
  label: words,
  shape: metricShape,
  unit: z.string().trim().min(1).max(40),
  source: metricSource,
  freshness: z.object({ every: z.string().trim().min(1).max(60) }).strict(),
  views: z.array(metricView).min(1).max(5),
  windowDays: z.number().int().min(1).max(3660).optional()
}).strict()
export type MetricDefinition = z.infer<typeof metricDefinition>

export const metricReading = z.object({
  metricId: slug,
  value: z.number().finite().nullable(),
  at: z.string().datetime({ offset: true }),
  provenance: z.object({ fetchedVia: z.string().trim().min(1).max(300), note: z.string().trim().max(1000).optional() }).strict(),
  status: z.enum(['fresh', 'stale', 'not-connected', 'failed'])
}).strict()
export type MetricReading = z.infer<typeof metricReading>

export const metricCatalogue = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  definitions: z.array(metricDefinition).max(200),
  savedAt: z.string().datetime({ offset: true }).nullable(),
  by: z.string().trim().min(1).max(160).nullable()
}).strict().refine(value => new Set(value.definitions.map(metric => metric.id)).size === value.definitions.length, 'Each metric needs a distinct id.')
export type MetricCatalogue = z.infer<typeof metricCatalogue>

export function blankCatalogue(): MetricCatalogue {
  return { version: 1, revision: 0, definitions: [], savedAt: null, by: null }
}

export interface PresentedMetric {
  id: string
  label: string
  shape: MetricShape
  unit: string
  source: 'damon' | 'connection'
  views: MetricView[]
  value: number | null
  text: string
  note: string
  state: 'fresh' | 'stale' | 'not-connected' | 'failed'
}

const running: MetricDefinition[] = [
  { id: 'things-running', label: 'Things running', shape: 'count', unit: 'things', source: { kind: 'damon', query: 'resources.operating' }, freshness: { every: 'live' }, views: ['live'] },
  { id: 'things-broken', label: 'Things broken', shape: 'count', unit: 'things', source: { kind: 'damon', query: 'resources.problems' }, freshness: { every: 'live' }, views: ['live'] }
]
const own = (id: string, label: string, shape: MetricShape, unit: string, every: string, extra: Partial<MetricDefinition> = {}): MetricDefinition =>
  ({ id, label, shape, unit, source: { kind: 'connection' }, freshness: { every }, views: ['live'], ...extra })

export function defaultCatalogueFor(kind: 'app' | 'business' | 'generic'): MetricDefinition[] {
  switch (kind) {
    case 'app':
      return [
        own('errors', 'Errors', 'count', 'errors', 'hourly'),
        own('daily-active-users', 'Daily active users', 'count', 'users', 'daily'),
        own('monthly-active-users', 'Monthly active users', 'count', 'users', 'daily'),
        own('all-time-downloads', 'All-time downloads', 'count', 'downloads', 'daily'),
        ...running
      ]
    case 'business':
      return [
        own('orders-this-month', 'Orders this month', 'series', 'orders', 'hourly', { windowDays: 30 }),
        own('revenue-this-month', 'Revenue this month', 'money', 'DKK', 'hourly', { windowDays: 30 }),
        own('customers', 'Customers', 'count', 'customers', 'daily'),
        ...running
      ]
    default:
      return [...running]
  }
}
