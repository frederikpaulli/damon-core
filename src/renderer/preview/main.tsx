// Preview of the Your turn screen outside Electron. It installs an in-memory
// stand-in for the preload bridge (window.damon) and renders the real
// component against the invented cards in fixtures.ts.
import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/source-sans-3'
import '@fontsource/ibm-plex-mono/400.css'
import '../src/styles.css'
import '../src/styles/foundation.css'
import '../src/styles/your-turn.css'
import YourTurnView from '../src/components/YourTurnView'
import { useDamon } from '../src/store'
import type { DamonApi } from '../src/api'
import type { YourTurnItem } from '../../shared/your-turn'
import { ITEMS, PROJECT_ID, TASKS } from './fixtures'

let items: YourTurnItem[] = structuredClone(ITEMS)
const close = (id: string): YourTurnItem[] => {
  items = items.map((i) => (i.id === id ? { ...i, doneAt: new Date().toISOString() } : i))
  return items
}
const same = async (): Promise<YourTurnItem[]> => items

const fake: DamonApi = {
  sendToManager: async () => {},
  listYourTurn: same,
  markYourTurnDone: async (_p, id) => close(id),
  returnYourTurn: async (_p, id) => close(id),
  fillYourTurn: async (_p, id) => {
    items = items.map((i) => (i.id === id ? { ...i, filledAt: new Date().toISOString(), leftToFill: 'nothing', readyToSubmit: true } : i))
    return items
  },
  sendYourTurn: async (_p, id) => close(id),
  editYourTurn: async (_p, id, text) => {
    items = items.map((i) => (i.id === id ? { ...i, text, editedAt: new Date().toISOString() } : i))
    return items
  },
  yourTurnSubmitted: async (_p, id) => close(id),
  yourTurnNotYet: same,
  checkYourTurnAnyway: same,
  closeYourTurnNotNeeded: async (_p, id) => close(id),
  closeYourTurnReplaced: async (_p, id) => close(id),
  answerCheck: async (_p, id) => close(id),
  answerPastCap: async (_p, id) => close(id),
  answerPrivatePage: async (_p, id) => close(id),
  answerReviewStuck: async (_p, id) => close(id),
  answerNeed: async () => ({ ok: true, items }),
  listNeedFiles: async () => [],
  sendReady: async () => true,
  outgoing: async (_p, id) => {
    const item = items.find((i) => i.id === id)
    return { attachments: (item?.files ?? []).map((file) => ({ file, exists: true })) }
  },
  openEmail: async () => ({ ok: true, inLink: true }),
  openFile: async () => true,
  revealFile: async () => true,
  openTeamBrowser: async () => ({ open: true }),
  standardsAnswerProposal: async () => ({ approved: [], pending: [] })
}
window.damon = fake
useDamon.setState({ selectedId: PROJECT_ID, tasks: { [PROJECT_ID]: TASKS }, rosters: { [PROJECT_ID]: [] }, chats: { [PROJECT_ID]: [] } })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main className="preview-shell">
      <YourTurnView projectId={PROJECT_ID} />
    </main>
  </React.StrictMode>
)
