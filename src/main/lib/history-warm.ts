import { z } from 'zod'
import { knownRecordText } from './durable-history'

const BATCH = 20
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const shell = z.object({ version: z.literal(1), projectId: z.string(), records: z.array(z.unknown()) }).strict()

export async function parseBookInTurns<R>(book: unknown, record: z.ZodType<R>): Promise<{ version: 1; projectId: string; records: R[] }> {
  const outer = shell.parse(book)
  const records: R[] = []
  for (let i = 0; i < outer.records.length; i++) {
    records.push(record.parse(outer.records[i]))
    if ((i + 1) % BATCH === 0) await turn()
  }
  return { version: 1, projectId: outer.projectId, records }
}

export async function bookTextInTurns(data: { version: number; projectId: string; records: unknown[] }): Promise<string> {
  const parts: string[] = []
  for (let i = 0; i < data.records.length; i++) {
    const text = JSON.stringify(data.records[i]) ?? 'null'
    knownRecordText(data.records[i], text)
    parts.push(text)
    if ((i + 1) % BATCH === 0) await turn()
  }
  return `{"version":${JSON.stringify(data.version)},"projectId":${JSON.stringify(data.projectId)},"records":[${parts.join(',')}]}`
}

export { turn as nextTurn }
