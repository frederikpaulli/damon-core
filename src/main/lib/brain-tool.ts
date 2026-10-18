import { z } from 'zod'
import { DECISIONS_CAP_CHARS, type BrainRefusal, type BrainSection, type BrainStore } from './brain-store'

export const WRITE_BRAIN_DESCRIPTION =
  `Keep the shared project brain current; every job reads it. "decisions" is what is true TODAY, at most ${DECISIONS_CAP_CHARS.toLocaleString('en-US')} characters: use mode "fix" with find/replace to correct one wrong line, "retire" with find set to a heading line to move that whole part to the archive when it is settled history or no longer true, "replace" to rewrite the whole section as the current state (what is retired or replaced is archived, never lost), "append" to add one new decision. Keep a "## Not now" heading in decisions listing what the project is deliberately not doing; every job is told it. "map" is the work breakdown, "glossary" the terms. Never write a secret: write where it lives.`

export const writeBrainInput = z.object({
  section: z.enum(['map', 'decisions', 'glossary']),
  mode: z.enum(['replace', 'append', 'fix', 'retire']).describe('fix corrects one exact passage; retire moves the part under one heading to the archive; replace rewrites the section; append adds one entry.'),
  content: z.string().min(1).max(20000).optional().describe('The new text, for replace and append.'),
  find: z.string().min(1).max(4000).optional().describe('For fix: the exact passage to change, unique in the section. For retire: the whole heading line, with its # marks.'),
  replace: z.string().max(4000).optional().describe('For fix: what it becomes.')
}).strict()
export type WriteBrainInput = z.infer<typeof writeBrainInput>

function refusalSentence(r: BrainRefusal): string {
  if (r.refused === 'secret') return `Not saved: ${r.detail}. The brain is read by every agent, so a key in it would be handed to all of them. Write down where the key lives, never the key itself.`
  return `Not saved: ${r.detail}`
}

export function writeBrainAnswer(brain: BrainStore, input: WriteBrainInput): string {
  const section = input.section as BrainSection
  let refused: BrainRefusal | null
  if (input.mode === 'fix') {
    if (!input.find || input.replace === undefined) return 'Not saved: mode "fix" needs both find and replace.'
    refused = brain.fix(section, input.find, input.replace)
  } else if (input.mode === 'retire') {
    if (!input.find) return 'Not saved: mode "retire" needs find, the heading line of the part to move to the archive.'
    refused = brain.retire(section, input.find)
    if (!refused) return `Moved "${input.find.trim().slice(0, 90)}" and everything under it to the archive (${section}). Every job reads the shorter section from its next turn.`
  } else {
    if (!input.content) return `Not saved: mode "${input.mode}" needs content.`
    refused = brain.write(section, input.content, input.mode)
  }
  return refused ? refusalSentence(refused) : `Saved to the brain (${section}). Every job reads it from its next turn.`
}
