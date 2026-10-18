// The part of the preload bridge (window.damon) the Your turn screen calls.
// In the app each method is an ipcRenderer.invoke to the main process; the
// preview page in preview/ supplies an in-memory stand-in.
import type { YourTurnItem } from '../../shared/your-turn'
import type { NeedReply } from '../../shared/work-needs'

type Items = Promise<YourTurnItem[]>

export interface DamonApi {
  sendToManager(projectId: string, text: string): Promise<void>
  listYourTurn(projectId: string): Items
  markYourTurnDone(projectId: string, id: string): Items
  returnYourTurn(projectId: string, id: string): Items
  fillYourTurn(projectId: string, id: string): Items
  sendYourTurn(projectId: string, id: string): Items
  editYourTurn(projectId: string, id: string, text: string): Items
  yourTurnSubmitted(projectId: string, id: string): Items
  yourTurnNotYet(projectId: string, id: string): Items
  checkYourTurnAnyway(projectId: string, id: string): Items
  closeYourTurnNotNeeded(projectId: string, id: string): Items
  closeYourTurnReplaced(projectId: string, id: string): Items
  answerCheck(projectId: string, id: string, allow: boolean): Items
  answerPastCap(projectId: string, id: string, allow: boolean): Items
  answerPrivatePage(projectId: string, id: string, allow: boolean): Items
  answerReviewStuck(projectId: string, id: string, answer: 'keep' | 'back' | 'again'): Items
  answerNeed(projectId: string, deliverableId: string, needId: string, reply: NeedReply, attach?: boolean): Promise<{ ok: boolean; canceled?: boolean; error?: string; items: YourTurnItem[] }>
  listNeedFiles(projectId: string): Promise<string[]>
  sendReady(): Promise<boolean>
  outgoing(projectId: string, id: string): Promise<{ attachments: { file: string; exists: boolean }[]; email?: { to: string; toName?: string; subject: string; body: string } } | null>
  openEmail(projectId: string, id: string): Promise<{ ok: boolean; inLink?: boolean; why?: string }>
  openFile(projectId: string, rel: string): Promise<boolean>
  revealFile(projectId: string, rel: string): Promise<boolean>
  openTeamBrowser(projectId: string, url?: string): Promise<{ open: boolean; note?: string } | null>
  standardsAnswerProposal(projectId: string, keep: boolean): Promise<{ approved: { id: string; text: string }[]; pending: string[] }>
}

declare global {
  interface Window {
    damon: DamonApi
  }
}

export {}
