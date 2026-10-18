// The Your turn screen: the owner's list of things only they can do.
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { LOADING, settle, type Load } from '../lib/load-state'
import { LoadFailed, Loading } from './LoadFailed'
import { useDamon } from '../store'
import { isForOwner } from '../../../shared/escalation'
import { CHECK_ANYWAY_TITLE } from '../../../shared/auto-check'
import { busyFilesLine, waitingFilesLine, jobToOpen } from '../../../shared/busy-files'
import { BUTTON, ownerTitle, safeUrl, canFill, canCloseNotNeeded, canCloseReplaced, canSend, canSendBack, consequenceOf, decisionEffects, explainLines, failureForOwner, groupItems, kindWords, leadFor, ownerWords, SEND_HELD_LEAD, sendBackMessage, submitActions, submitStage, withoutOldButtonSentence, type YourTurnItem } from '../../../shared/your-turn'
import { isOwnerConfirmation } from '../../../shared/critic-reach'
import type { TaskInfo } from '../../../shared/types'
import { insideProject, safeToOpen } from '../../../shared/openable'
import { useOwnerNeeds, type OwnerNeed } from '../lib/owner-needs'
import type { NeedCard, NeedReply } from '../../../shared/work-needs'
import { errorText } from '../lib/error-text'
import { beforeYouPress, cautionNotes, emailFileOf, emailRecipient, heldReason, isEmailCard, listWords, noteLines, outgoingFiles, pasteFields, usesOutwardLayout, withoutIds as withoutIdsText } from '../../../shared/outward-card'

export function NeedsActionRow({ n, onGo }: { n: Pick<OwnerNeed, 'verb' | 'title' | 'what' | 'context' | 'go'>; onGo: () => void }): JSX.Element {
  return (
    <li className="your-turn-row clickable" onClick={onGo}>
      <span className="your-turn-kind"><span className="your-turn-verb">{n.verb}</span></span>
      <div className="your-turn-body">
        <h3 className="your-turn-title">{n.title}</h3>
        <div className="your-turn-what">{n.what}</div>
        {n.context ? <div className="your-turn-context">{n.context}</div> : null}
        <div className="your-turn-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn small primary" onClick={onGo}>{BUTTON.open(n.go === 'spend' ? 'Limits' : n.go === 'fleet' ? 'Team' : 'the chat')}</button>
        </div>
      </div>
    </li>
  )
}

export function BlockerRow({ b, onConnect }: { b: { id: string; what: string; why: string }; onConnect: () => void }): JSX.Element {
  return (
    <li className="your-turn-row">
      <span className="your-turn-kind connect">
        <span className="your-turn-verb">Connect</span>
        <span className="your-turn-consequence">Gives Damon a key</span>
      </span>
      <div className="your-turn-body">
        <h3 className="your-turn-title">{b.what}</h3>
        <div className="your-turn-what">{b.why}</div>
        <div className="your-turn-actions">
          <button className="btn small primary" onClick={onConnect}>{BUTTON.open('Connections')}</button>
        </div>
      </div>
    </li>
  )
}

export async function readYourTurnOnce(projectId: string): Promise<Load<YourTurnItem[]>> {
  const read = await settle(() => window.damon.listYourTurn(projectId), 'Damon could not read what is waiting for you.')
  if (read.phase === 'ready' && useDamon.getState().yourTurn[projectId] === undefined) {
    useDamon.getState().receiveYourTurn({ projectId, items: read.value })
  }
  return read
}

export default function YourTurnView({ projectId }: { projectId: string }): JSX.Element {
  const itemsRaw = useDamon((s) => s.yourTurn[projectId])
  const blockersRaw = useDamon((s) => s.blockers[projectId])
  const tasksRaw = useDamon((s) => s.tasks[projectId])
  const held = useDamon((s) => s.holds[projectId] ?? false)
  const receiveYourTurn = useDamon((s) => s.receiveYourTurn)
  const setTab = useDamon((s) => s.setTab)
  const openJobFor = (i: YourTurnItem): { name: string; open: () => void } | null => { const j = jobToOpen(i, tasksRaw); return j ? { name: j.name, open: () => setTab(projectId, 'fleet') } : null }
  const setConnectionsOpen = useDamon((s) => s.setConnectionsOpen)
  const setSpendLimitOpen = useDamon((s) => s.setSpendLimitOpen)
  const [sendReady, setSendReady] = useState(false)
  useEffect(() => { let live = true; void window.damon.sendReady().then(r => { if (live) setSendReady(r) }).catch(() => {}); return () => { live = false } }, [])
  const needs = useOwnerNeeds(projectId)
  const loaded = itemsRaw !== undefined
  const [ownRead, setOwnRead] = useState<Load<YourTurnItem[]>>(LOADING)
  const readAgain = (): void => {
    setOwnRead(LOADING)
    void readYourTurnOnce(projectId).then(setOwnRead)
  }
  useEffect(() => {
    if (!loaded) readAgain()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])
  const items = itemsRaw ?? []
  const groups = groupItems(items)
  const open = groups.flatMap((g) => g.items)
  const blockers = blockersRaw ?? []
  const escalated = (tasksRaw ?? []).filter(isForOwner)
  const [busy, setBusy] = useState<string | null>(null)
  const [savedNotice,setSavedNotice] = useState('')
  const send = useDamon((s) => s.send)
  const [answer, setAnswer] = useState('')
  const [sending, setSending] = useState(false)
  const sendAnswer = async (need: OwnerNeed): Promise<void> => {
    const text = answer.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await send(`Answering your question "${need.what}": ${text}`)
      setAnswer('')
    } finally {
      setSending(false)
    }
  }
  const sendBack = async (item: YourTurnItem, note: string): Promise<void> => {
    if (busy) return
    setBusy(item.id)
    try {
      receiveYourTurn({ projectId, items: await window.damon.returnYourTurn(projectId, item.id) })
      void send(sendBackMessage(item, note))
    } finally {
      setBusy(null)
    }
  }
  const fillIt = async (item: YourTurnItem): Promise<void> => {
    if (busy) return
    setBusy(item.id)
    try {
      receiveYourTurn({ projectId, items: await window.damon.fillYourTurn(projectId, item.id) })
    } finally {
      setBusy(null)
    }
  }
  const sendIt = async (item: YourTurnItem): Promise<void> => {
    if (busy) return
    setBusy(item.id)
    try {
      receiveYourTurn({ projectId, items: await window.damon.sendYourTurn(projectId, item.id) })
    } finally {
      setBusy(null)
    }
  }
  const editIt = async (item: YourTurnItem, text: string): Promise<void> => {
    receiveYourTurn({ projectId, items: await window.damon.editYourTurn(projectId, item.id, text) })
  }
  const goTo = (need: OwnerNeed): void => {
    if (need.go === 'chat') setTab(projectId, 'chat')
    else if (need.go === 'fleet') setTab(projectId, 'fleet')
    else setSpendLimitOpen(true)
  }

  const answerCheck = async (item: YourTurnItem, allow: boolean): Promise<void> => {
    if (busy) return
    setBusy(item.id)
    try {
      receiveYourTurn({ projectId, items: await window.damon.answerCheck(projectId, item.id, allow) })
    } finally {
      setBusy(null)
    }
  }
  const answerPastCap = async (item: YourTurnItem, allow: boolean): Promise<void> => {
    if (busy) return
    setBusy(item.id)
    try {
      receiveYourTurn({ projectId, items: await window.damon.answerPastCap(projectId, item.id, allow) })
    } finally {
      setBusy(null)
    }
  }
  const answerReviewStuck = async (item: YourTurnItem, answer: 'keep' | 'back' | 'again'): Promise<void> => {
    if (busy) return
    setBusy(item.id)
    try {
      receiveYourTurn({ projectId, items: await window.damon.answerReviewStuck(projectId, item.id, answer) })
    } finally {
      setBusy(null)
    }
  }
  const answerPrivatePage = async (item: YourTurnItem, allow: boolean): Promise<void> => {
    if (busy) return
    setBusy(item.id)
    try {
      receiveYourTurn({ projectId, items: await window.damon.answerPrivatePage(projectId, item.id, allow) })
    } finally {
      setBusy(null)
    }
  }
  const mark = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(id)
    try {
      receiveYourTurn({ projectId, items: await window.damon.markYourTurnDone(projectId, id) })
    } finally {
      setBusy(null)
    }
  }

  const submitted = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(id)
    try {
      receiveYourTurn({ projectId, items: await window.damon.yourTurnSubmitted(projectId, id) })
    } finally {
      setBusy(null)
    }
  }
  const notYet = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(id)
    try {
      receiveYourTurn({ projectId, items: await window.damon.yourTurnNotYet(projectId, id) })
    } finally {
      setBusy(null)
    }
  }

  const checkAnyway = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(id)
    try {
      receiveYourTurn({ projectId, items: await window.damon.checkYourTurnAnyway(projectId, id) })
    } finally {
      setBusy(null)
    }
  }
  const notNeeded = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(id)
    try {
      receiveYourTurn({ projectId, items: await window.damon.closeYourTurnNotNeeded(projectId, id) })
    } finally {
      setBusy(null)
    }
  }

  const replaced = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(id)
    try {
      receiveYourTurn({ projectId, items: await window.damon.closeYourTurnReplaced(projectId, id) })
    } finally {
      setBusy(null)
    }
  }

  const nothing = loaded && open.length === 0 && blockers.length === 0 && escalated.length === 0 && needs.length === 0
  const handed = byWhatItCosts(open.filter((i) => !i.waitingOn))
  const notReady = open.filter((i) => Boolean(i.waitingOn))

  return (
    <div className="your-turn">
      {savedNotice ? <p className="your-turn-saved" role="status">{savedNotice}</p> : null}
      {!loaded ? (
        ownRead.phase === 'failed'
          ? <LoadFailed what="Your turn" error={ownRead.error} onRetry={readAgain} />
          : <Loading text="Reading what needs you…" />
      ) : null}
      {nothing ? (
        <div className="your-turn-empty d-empty">
          <h2 className="your-turn-empty-title d-empty-title">Nothing needs you.</h2>
          <p className="your-turn-empty-note">
            {held ? 'Work is paused. Resume it from the controls at the top of this project. ' : ''}
            Anything that needs your hands — a message to
            send, something to pay for, a decision only you can make — lands here and stays until you mark it done.
          </p>
          <button className="btn" onClick={() => setTab(projectId, 'fleet')}>
            See what the team is doing
          </button>
        </div>
      ) : null}

      {needs.length > 0 ? (
        <section>
          <SectionHead label="Damon has stopped here" count={needs.length} />
          <ul className="your-turn-list">
            {needs.map((n) =>
              n.go === 'chat' ? (
                <li key={n.key} className="your-turn-row">
                  <span className="your-turn-kind"><span className="your-turn-verb">{n.verb}</span></span>
                  <div className="your-turn-body">
                    <h3 className="your-turn-title">{n.title}</h3>
                    <div className="your-turn-what">{n.what}</div>
                    {n.context ? <div className="your-turn-context">{n.context}</div> : null}
                    <div className="your-turn-answer">
                      <label htmlFor={`reply-${n.key}`}>Your answer</label>
                      <textarea
                        id={`reply-${n.key}`}
                        value={answer}
                        placeholder="It goes into the chat as your reply to this question."
                        rows={2}
                        onChange={(e) => setAnswer(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            void sendAnswer(n)
                          }
                        }}
                      />
                      <button className="btn small primary" disabled={sending || !answer.trim()} onClick={() => void sendAnswer(n)}>
                        {sending ? 'Sending your answer…' : 'Send your answer'}
                      </button>
                    </div>
                  </div>
                  <div className="your-turn-actions">
                    <button className="btn small" onClick={() => goTo(n)}>
                      Open the chat
                    </button>
                  </div>
                </li>
              ) : (
                <NeedsActionRow key={n.key} n={n} onGo={() => goTo(n)} />
              )
            )}
          </ul>
        </section>
      ) : null}

      {blockers.length > 0 ? (
        <section>
          <SectionHead label="Not connected" count={blockers.length} />
          <ul className="your-turn-list">
            {blockers.map((b) => (
              <BlockerRow key={b.id} b={b} onConnect={() => setConnectionsOpen(true, { projectId, blockerId: b.id, search: b.what })} />
            ))}
          </ul>
        </section>
      ) : null}

      {escalated.length > 0 ? (
        <section>
          <SectionHead label={escalated.length === 1 ? 'A teammate is stuck' : 'Teammates are stuck'} count={escalated.length} />
          <ul className="your-turn-list">
            {escalated.map((t) => (
              <EscalationCard key={t.id} task={t} onAnswer={(text) => send(`About the stuck job "${t.label || t.title}": ${text}`)} onOpenChat={() => setTab(projectId, 'chat')} />
            ))}
          </ul>
        </section>
      ) : null}

      {handed.length > 0 ? (
        <section>
          <SectionHead
            label="Handed to you"
            count={handed.length}
            note={handed.length > 1 ? 'Start at the top: what reaches your accounts, then what has waited longest.' : undefined}
          />
          <ul className="your-turn-list your-turn-handed">
            {handed.map((i) => i.need && i.kind === 'login' && i.url ? (
              <SignInRow key={i.id} item={i} projectId={projectId} onChanged={(items,message) => {receiveYourTurn({ projectId, items });if(message)setSavedNotice(message)}} />
            ) : i.need ? (
              <NeedRow key={i.id} need={i.need} projectId={projectId} onChanged={(items,message) => {receiveYourTurn({ projectId, items });if(message)setSavedNotice(message)}} />
            ) : (
              <Row
                key={i.id}
                item={i}
                projectId={projectId}
                busy={busy === i.id}
                onDone={() => void mark(i.id)}
                onSubmitted={() => void submitted(i.id)}
                onNotYet={() => void notYet(i.id)}
                onSendBack={canSendBack(i) ? (note) => void sendBack(i, note) : undefined}
                onNotNow={i.kind === 'login' ? () => void sendBack(i, '') : undefined}
                onNotNeeded={canCloseNotNeeded(i) ? () => void notNeeded(i.id) : undefined}
                onReplaced={canCloseReplaced(i, open) ? () => void replaced(i.id) : undefined}
                onCheckAnyway={i.kind === 'submit' || i.kind === 'send' ? () => void checkAnyway(i.id) : undefined}
                onSend={canSend(i) && sendReady ? () => void sendIt(i) : undefined} sendHeld={canSend(i) && !sendReady}
                onFill={canFill(i) ? () => void fillIt(i) : undefined}
                busyLine={busyFilesLine(i, tasksRaw)} waitingLine={waitingFilesLine(i, tasksRaw)} openJob={openJobFor(i)}
                onEdit={i.text ? (text) => void editIt(i, text) : undefined}
                onCheck={i.projectCheck ? (allow) => void answerCheck(i, allow) : undefined}
                onPastCap={i.pastCap ? (allow) => void answerPastCap(i, allow) : undefined}
                onReviewStuck={i.reviewStuck ? (answer) => void answerReviewStuck(i, answer) : undefined}
                onPrivatePage={i.privatePage ? (allow) => void answerPrivatePage(i, allow) : undefined}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {notReady.length > 0 ? (
        <section className="your-turn-not-ready">
          <SectionHead label="Not ready yet" count={notReady.length} note="Blocked on Damon's own work. Nothing for you to do; each card wakes up when its check clears." />
          <ul className="your-turn-list">
            {notReady.map((i) => (
              <Row key={i.id} item={i} projectId={projectId} busy={busy === i.id} onDone={() => void mark(i.id)} onSubmitted={() => void submitted(i.id)} onNotYet={() => void notYet(i.id)} onSendBack={canSendBack(i) ? (note) => void sendBack(i, note) : undefined} onNotNow={i.kind === 'login' ? () => void sendBack(i, '') : undefined} onSend={canSend(i) && sendReady ? () => void sendIt(i) : undefined} sendHeld={canSend(i) && !sendReady} onFill={canFill(i) ? () => void fillIt(i) : undefined} busyLine={busyFilesLine(i, tasksRaw)} waitingLine={waitingFilesLine(i, tasksRaw)} openJob={openJobFor(i)} onEdit={i.text ? (text) => void editIt(i, text) : undefined} onCheckAnyway={i.kind === 'submit' || i.kind === 'send' ? () => void checkAnyway(i.id) : undefined} />
            ))}
          </ul>
        </section>
      ) : null}

    </div>
  )
}

function SectionHead({ label, count, note }: { label: string; count: number; note?: string }): JSX.Element {
  return (
    <div className="your-turn-band-group">
      <h2 className="d-band your-turn-band">
        {label}
        <span className="your-turn-count">{count}</span>
      </h2>
      {note ? <p className="your-turn-band-note">{note}</p> : null}
    </div>
  )
}

export function SignInRow({ item, projectId, onChanged }: { item: YourTurnItem; projectId: string; onChanged: (items: YourTurnItem[], message?: string) => void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const open = async (): Promise<void> => {
    setBusy(true); setNote('')
    try {
      const status = await window.damon.openTeamBrowser(projectId, item.url)
      if (status && 'note' in status && status.note) setNote(String(status.note))
    } catch (e) {
      setNote(e instanceof Error && e.message ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : "The team's browser could not be opened. Open Connections and start it from there.")
    }
    finally { setBusy(false) }
  }
  const without = async (): Promise<void> => {
    if (!item.need) return
    setBusy(true); setNote('')
    try {
      const result = await window.damon.answerNeed(projectId, item.need.deliverableId, item.need.needId, { action: 'omit', revision: item.need.revision })
      onChanged(result.items, result.ok ? 'Noted. The work continues without that sign-in and says so in its report.' : undefined)
      if (!result.ok) setNote(result.error ?? 'That could not be recorded. Try again.')
    } catch { setNote('That could not be recorded. Try again.') }
    finally { setBusy(false) }
  }
  const done = async (): Promise<void> => {
    setBusy(true); setNote('')
    try {
      const items = await window.damon.markYourTurnDone(projectId, item.id)
      const still = items.find((i) => i.id === item.id && !i.doneAt)
      onChanged(items, still ? undefined : 'Signed in. The work that waited for it carries on.')
      if (still) setNote('Damon looked at the page in the team\'s browser and it still shows a sign-in wall. Sign in there, then press Done once more.')
    } catch { setNote('That could not be recorded. Try again.') }
    finally { setBusy(false) }
  }
  return <li className="your-turn-row need-row">
    <span className="your-turn-kind login"><span className="your-turn-verb">{kindWords('login')}</span></span>
    <div className="your-turn-body">
      <h3 className="your-turn-title">{ownerTitle(item)}</h3>
      <div className="your-turn-what">{item.what}</div>
      <div className="need-controls">
        <button className="btn small primary" disabled={busy} onClick={() => void open()}>{BUTTON.open('the sign-in page')}</button>
        <button className="btn small" disabled={busy} onClick={() => void done()}>{BUTTON.done}</button>
        <button className="btn small quiet" disabled={busy} onClick={() => void without()}>Continue without signing in</button>
      </div>
      {note ? <div className="need-error">{note}</div> : null}
    </div>
  </li>
}

export function NeedRow({ need, projectId, onChanged }: { need: NeedCard; projectId: string; onChanged: (items: YourTurnItem[],message?:string) => void }): JSX.Element {
  const inFlight = useRef(false)
  const [answer, setAnswer] = useState('')
  const [files, setFiles] = useState<string[] | null>(null)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = useDamon((s) => s.send)
  const [asked, setAsked] = useState(false)
  const submit = async (action: NeedReply['action'], value?: string, attach = false): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setError('')
    try {
      const result = await window.damon.answerNeed(projectId, need.deliverableId, need.needId, { action, value, revision: need.revision }, attach)
      onChanged(result.items,result.ok ? 'Your choice is saved. Damon checks it before the work that depends on it carries on. If the project is on hold, it stays on hold.' : undefined)
      if (!result.ok) setError(result.error ?? 'Your answer could not be saved. Try again.')
    } catch { setError('Your answer could not be saved. Try again.') }
    finally { inFlight.current = false; setBusy(false) }
  }
  const chooseExisting = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setError('')
    try { setFiles(await window.damon.listNeedFiles(projectId)) }
    catch { setError('The project files could not be listed. Try again or attach a file.') }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <li className="your-turn-row need-row">
    <span className="your-turn-kind decide"><span className="your-turn-verb">{need.input === 'file' ? 'Provide' : 'Answer'}</span></span>
    <div className="your-turn-body">
      <h3 className="your-turn-title">{need.title}</h3>
      <div className="your-turn-context">For {need.deliverable} · {need.importance === 'required' ? 'Required for completion' : need.importance === 'recommended' ? 'Recommended; your choice' : 'Optional'}</div>
      <div className="your-turn-what">{need.why}</div>
      {need.input === 'file' ? <div className="need-controls">
        <button className="btn small primary" disabled={busy} onClick={() => void submit('file', undefined, true)}>Attach a file</button>
        <button className="btn small" disabled={busy} onClick={() => void chooseExisting()}>Choose from project</button>
        {files && <div className="need-existing">
          <label htmlFor={`file-${need.id}`}>Existing file</label>
          <select id={`file-${need.id}`} value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}>
            <option value="">{files.length ? 'Choose a file' : 'No project files found'}</option>
            {files.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          <button className="btn small primary" disabled={busy || !selected} onClick={() => void submit('file', selected)}>Use this file</button>
        </div>}
      </div> : <div className="your-turn-answer">
        <label htmlFor={`answer-${need.id}`}>Your answer</label>
        <textarea
          id={`answer-${need.id}`}
          value={answer}
          disabled={busy}
          rows={3}
          onChange={e => setAnswer(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && answer.trim() && !busy) {
              e.preventDefault()
              void submit('answer', answer)
            }
          }}
        />
        <button className="btn small primary" disabled={busy || !answer.trim()} onClick={() => void submit('answer', answer)}>Save answer</button>
      </div>}
      {need.importance !== 'required' ? (
        <button className="btn small" disabled={busy} onClick={() => void submit('omit')}>Leave it out</button>
      ) : (
        <button
          className="btn small"
          disabled={busy || asked}
          onClick={() => {
            setAsked(true)
            void send(
              `I cannot give you "${need.title}" for "${need.deliverable}". Find another way to settle it, or drop the ` +
                'requirement and tell me what that costs. Do not leave the job waiting on me for this one.'
            )
          }}
        >
          {asked ? 'Damon has been asked' : 'I cannot give you this'}
        </button>
      )}
      {busy && <div role="status" className="your-turn-context">Saving your choice…</div>}
      {error && <div role="alert" className="need-error">{error}</div>}
    </div>
  </li>
}

export function Row(props: RowProps): JSX.Element {
  return usesOutwardLayout(props.item) ? <OutwardRow {...props} /> : <ClassicRow {...props} />
}

type RowProps = {
  item: YourTurnItem
  projectId: string
  busy: boolean
  onDone: () => void
  onSubmitted?: () => void
  onNotYet?: () => void
  onSendBack?: (note: string) => void
  onNotNow?: () => void
  onNotNeeded?: () => void
  onReplaced?: () => void
  onCheckAnyway?: () => void
  onSend?: () => void
  sendHeld?: boolean
  onFill?: () => void
  busyLine?: string | null
  waitingLine?: string | null
  openJob?: { name: string; open: () => void } | null
  onEdit?: (text: string) => void
  onCheck?: (allow: boolean) => void
  onPastCap?: (allow: boolean) => void
  onReviewStuck?: (answer: 'keep' | 'back' | 'again') => void
  onPrivatePage?: (allow: boolean) => void
}

function ClassicRow({
  item,
  projectId,
  busy,
  onDone,
  onSubmitted,
  onNotYet,
  onSendBack,
  onNotNow,
  onNotNeeded,
  onReplaced,
  onCheckAnyway,
  onSend,
  sendHeld,
  onFill,
  busyLine,
  waitingLine,
  openJob,
  onEdit,
  onCheck,
  onPastCap,
  onReviewStuck,
  onPrivatePage
}: RowProps): JSX.Element {
  const filesListed = (item.files ?? []).length > 1
  const inside = item.file ? insideProject(item.file) : false
  const openable = inside && safeToOpen(item.file!)
  const cost = consequenceOf(item)
  const waited = waitedWords(item.at)
  const clock = clockOf(item.at)
  const sendable = Boolean(onSend) && canSend(item)
  const copyToSend = !sendable && Boolean(sendHeld) && canSend(item)
  const sending = Boolean(item.sendingAt)
  const fillable = Boolean(onFill) && canFill(item)
  const filling = Boolean(item.fillingAt)
  const stage = submitStage(item)
  const [whole, setWhole] = useState(false)
  const long = (item.text ?? '').length > 280 || (item.text ?? '').split('\n').length > 4
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text ?? '')
  const [askingWhy, setAskingWhy] = useState(false)
  const [why, setWhy] = useState('')
  const site = item.url
  const goToSite =
    item.kind !== 'connect' && site && /^https?:\/\//i.test(site)
      ? (): void => void window.damon.openTeamBrowser(projectId, site)
      : null
  const setConnectionsOpen = useDamon((s) => s.setConnectionsOpen)
  const openConnections = item.kind === 'connect'
    ? (): void => setConnectionsOpen(true, { projectId, blockerId: `connect:${item.connect?.presetKey ?? ''}`, search: item.connect?.presetKey ? undefined : item.connect?.provider })
    : null
  const setTab = useDamon((s) => s.setTab)
  const setAccountsOpen = useDamon((s) => s.setAccountsOpen)
  const question = item.kind === 'decide' && !item.sendBack && !item.critiqueDecision && !item.standard && !item.knownFault && !item.privatePage && !item.pastCap && !item.reviewStuck
  const openNamedScreen = item.opens === 'accounts'
    ? (): void => setAccountsOpen(true)
    : item.opens === 'connections'
      ? (): void => setConnectionsOpen(true, { projectId, blockerId: `opens:${item.id}` })
      : item.opens === 'chat' || question
        ? (): void => setTab(projectId, 'chat')
        : null
  const primary = openConnections ?? openNamedScreen ?? goToSite ?? (item.file && openable ? (): void => void window.damon.openFile(projectId, item.file!) : null)
  const answerStandard = item.standard
    ? async (keep: boolean): Promise<void> => {
        await window.damon.standardsAnswerProposal(projectId, keep)
        onDone()
      }
    : null
  const stop = (e: ReactMouseEvent): void => e.stopPropagation()
  const lead = copyToSend ? SEND_HELD_LEAD : leadFor(item)
  const allLines = (explainLines(item.what) ?? []).filter((l) => !/^(what to do|keep it|send it back)$/i.test(l.label)).map((l) => ({ ...l, text: ownerWords(l.text) }))
  const effects = decisionEffects(item)
  const dispute = item.kind === 'decide' && Boolean(item.sendBack || item.critiqueDecision)
  const sides = dispute ? allLines.filter((l) => /^(why|damon.s reason)$/i.test(l.label)) : []
  const lines = dispute ? allLines.filter((l) => !sides.includes(l)) : allLines
  const plain = explainLines(item.what) ? '' : ownerWords(effects ? withoutOldButtonSentence(item.what) : item.what)
  const checkCommands = Boolean(item.projectCheck || item.projectChecks?.length)
  const generic = Boolean(plain) && !stage && !item.standard && item.kind !== 'decide' && item.kind !== 'send' && item.kind !== 'login' && !checkCommands
  const effect = sendable
    ? 'Send posts these exact words in the team’s browser, where you are signed in. It goes out as you.'
    : copyToSend
      ? 'Copy the words, open the thread, paste them and send them yourself, then press Done. Damon cannot post messages for you from here yet.'
    : stage === 'fill' && fillable
      ? 'Fill it in fills the form and stops before the site’s own last button, so the last press is yours. Damon cannot see what you send, so press I pressed Submit only once you have actually sent it.'
      : stage === 'filled'
        ? 'Damon cannot see what you send, so press I pressed Submit only once you have actually sent it. Not yet takes the fill back. Fill it in, under Details, starts the form over and loses anything you typed there.'
        : stage === 'by-hand'
          ? 'Damon cannot see what you send, so press I pressed Submit only once you have actually sent it.'
          : ''
  const confirmation = Boolean(item.critiqueDecision && isOwnerConfirmation(item.critiqueDecision.challenge))
  const doneLabel = item.knownFault ? 'Release' : ((onSendBack && item.kind === 'decide' && !question) || answerStandard) && !confirmation ? BUTTON.keep : BUTTON.done
  const siteLabel = BUTTON.open('the page')
  const sendBackButton = onSendBack && !askingWhy && !answerStandard && !question && item.kind !== 'login'
    ? <button className="btn small danger" disabled={busy || sending} title="Tells Damon you are not satisfied. You can say why. The job goes back to the team." onClick={() => setAskingWhy(true)}>Send it back</button>
    : null
  const submitSet = item.kind === 'submit' ? submitActions(item) : null
  const doneButton = answerStandard || (submitSet && !submitSet.includes('submitted')) ? null : (
    <button className={`btn small${item.waitingOn || (primary && (sendable || copyToSend || (item.kind === 'login' && goToSite) || openConnections || openNamedScreen || question || stage === 'fill' || stage === 'failed')) ? '' : ' primary'}`} disabled={busy || sending || filling} onClick={submitSet ? (onSubmitted ?? onDone) : onDone}>
      {submitSet ? BUTTON.submitted : doneLabel}
    </button>
  )
  const notYetButton = submitSet?.includes('notYet')
    ? <button key="notyet" className="btn small" disabled={busy || filling} title="Nothing is recorded as sent. The fill is taken back and the card stays on your list." onClick={onNotYet}>{BUTTON.notYet}</button>
    : null
  let now: JSX.Element[] = []
  let later: JSX.Element[] = []
  if (openConnections) {
    now = [<button key="conn" className="btn small primary" disabled={busy} onClick={openConnections}>Open Connections</button>, doneButton!]
  } else if (answerStandard) {
    now = [
      <button key="add" className="btn small primary" disabled={busy} onClick={() => void answerStandard(true)}>{BUTTON.keep}</button>,
      <button key="no" className="btn small danger" disabled={busy} onClick={() => void answerStandard(false)}>{BUTTON.sendBack}</button>
    ]
  } else if (stage === 'fill') {
    now = [
      <button key="fill" className="btn small primary" disabled={busy || filling || !!busyLine} onClick={onFill}>{filling ? 'Filling it in…' : BUTTON.fill}</button>,
      ...(goToSite ? [<button key="site" className="btn small" disabled={filling} onClick={goToSite}>{siteLabel}</button>] : [])
    ]
    later = [doneButton!, ...(sendBackButton ? [sendBackButton] : [])]
  } else if (stage === 'filled') {
    now = [doneButton!, ...(notYetButton ? [notYetButton] : []), ...(goToSite ? [<button key="site" className="btn small" onClick={goToSite}>{BUTTON.open('the form')}</button>] : [])]
    later = [<button key="again" className="btn small" disabled={busy || filling || !!busyLine} onClick={onFill}>{BUTTON.fill}</button>, ...(sendBackButton ? [sendBackButton] : [])]
  } else if (stage === 'failed') {
    now = [
      ...(goToSite ? [<button key="site" className="btn small primary" onClick={goToSite}>{siteLabel}</button>] : []),
      <button key="again" className="btn small" disabled={busy || filling || !!busyLine} onClick={onFill}>{filling ? 'Filling it in…' : BUTTON.fill}</button>
    ]
    later = [doneButton!, ...(sendBackButton ? [sendBackButton] : [])]
  } else if (stage === 'by-hand') {
    now = [doneButton!]
    later = sendBackButton ? [sendBackButton] : []
  } else if (item.waitingOn) {
    now = goToSite ? [<button key="site" className="btn small" onClick={goToSite}>{BUTTON.open(item.kind === 'send' ? 'the thread' : 'the page')}</button>] : []
    later = [...(item.kind === 'submit' ? [<button key="fill" className="btn small" disabled={busy || filling || !!busyLine} onClick={onFill}>{BUTTON.fill}</button>] : []), doneButton!, ...(item.text ? [<CopyButton key="copy" text={item.text} />] : []), ...(sendBackButton ? [sendBackButton] : [])]
  } else if (copyToSend) {
    now = [
      <CopyButton key="copy" text={item.text!} primary />,
      ...(goToSite ? [<button key="site" className="btn small" onClick={goToSite}>{BUTTON.open('the thread')}</button>] : [])
    ]
    later = [doneButton!, ...(sendBackButton ? [sendBackButton] : [])]
  } else if (sendable) {
    now = [
      <button key="send" className="btn small primary" disabled={busy || sending || editing || !!busyLine} title="Damon posts these exact words in the team's browser, where you are signed in, and tells you when it has landed." onClick={onSend}>{sending ? 'Sending…' : 'Send'}</button>,
      ...(goToSite ? [<button key="site" className="btn small" disabled={sending} onClick={goToSite}>{BUTTON.open('the thread')}</button>] : [])
    ]
    later = [doneButton!, ...(item.text ? [<CopyButton key="copy" text={item.text} />] : []), ...(sendBackButton ? [sendBackButton] : [])]
  } else if (onReviewStuck && item.reviewStuck) {
    now = [
      <button key="keep" className="btn small primary" disabled={busy} title="Read the draft on the Files tab first. It goes into your folder as yours." onClick={() => onReviewStuck('keep')}>Keep it</button>,
      <button key="back" className="btn small" disabled={busy} title="The writer does the work again." onClick={() => onReviewStuck('back')}>Send it back</button>,
      <button key="again" className="btn small" disabled={busy} title="Damon runs the independent review once more, now." onClick={() => onReviewStuck('again')}>Try the review again</button>
    ]
  } else if (onPastCap && item.pastCap) {
    now = [
      <button key="again" className="btn small primary" disabled={busy} title="The team gets one more go at this work." onClick={() => onPastCap(true)}>Try once more</button>,
      <button key="stop" className="btn small" disabled={busy} title="The work ends here; the manager is told to change what is asked." onClick={() => onPastCap(false)}>Stop here</button>
    ]
  } else if (onPrivatePage && item.privatePage) {
    now = [
      <button key="allow" className="btn small primary" disabled={busy} title="This one job may open, read and look at the page, for two hours at most. Damon keeps no copy." onClick={() => onPrivatePage(true)}>{BUTTON.allow}</button>,
      <button key="decline" className="btn small" disabled={busy} title="The job carries on without the page." onClick={() => onPrivatePage(false)}>{BUTTON.decline}</button>
    ]
    later = goToSite ? [<button key="site" className="btn small" onClick={goToSite}>{BUTTON.open('the page')}</button>] : []
  } else if (onCheck && item.projectCheck) {
    now = [
      <button key="allow" className="btn small primary" disabled={busy} title="Damon's reviewers may run exactly this command in a throwaway copy of the project." onClick={() => onCheck(true)}>Allow</button>,
      <button key="deny" className="btn small" disabled={busy} title="They keep checking by reading only." onClick={() => onCheck(false)}>{BUTTON.decline}</button>
    ]
  } else if (question) {
    now = [<button key="chat" className="btn small primary" disabled={busy} onClick={openNamedScreen!}>{BUTTON.open('the chat')}</button>, doneButton!]
  } else if (openNamedScreen) {
    now = [
      <button key="door" className="btn small primary" disabled={busy} onClick={openNamedScreen}>{BUTTON.open(item.opens === 'accounts' ? 'Accounts' : item.opens === 'chat' ? 'the chat' : 'Connections')}</button>,
      doneButton!
    ]
    later = sendBackButton ? [sendBackButton] : []
  } else if (item.kind === 'login' && goToSite) {
    now = [
      <button key="site" className="btn small primary" disabled={sending} onClick={goToSite}>{BUTTON.open('the sign-in page')}</button>,
      doneButton!,
      ...(onNotNow ? [<button key="notnow" className="btn small quiet" disabled={busy} title="Tells Damon you did not sign in, so the work carries on without it." onClick={onNotNow}>Not now</button>] : [])
    ]
    later = item.text ? [<CopyButton key="copy" text={item.text} />] : []
  } else {
    now = [
      doneButton!,
      ...(goToSite ? [<button key="site" className="btn small" disabled={sending} onClick={goToSite}>{BUTTON.open(item.kind === 'send' ? 'the thread' : 'the page')}</button>] : []),
      ...(sendBackButton ? [sendBackButton] : [])
    ]
    later = item.text ? [<CopyButton key="copy" text={item.text} />] : []
  }
  now = now.filter(Boolean)
  later = later.filter(Boolean)
  if (onCheckAnyway && busyLine) now.push(<button key="checkanyway" className="btn small" disabled={busy} title={CHECK_ANYWAY_TITLE} onClick={(e) => { e.stopPropagation(); onCheckAnyway() }}>Check anyway</button>)
  if (onReplaced) now.push(<button key="replaced" className="btn small quiet" disabled={busy} title="Takes this card off your list because a newer card for the same files replaces it. Damon does not take it as sent." onClick={onReplaced}>Replaced by the newer card</button>)
  if (onNotNeeded) now.push(<button key="notneeded" className="btn small quiet" disabled={busy} title="Takes this off your list. Damon does not take it as done." onClick={onNotNeeded}>No longer needed</button>)
  if (!filesListed) {
    const fileButton = item.file && openable ? <button key="open" className="btn small" onClick={() => void window.damon.openFile(projectId, item.file!)}>{BUTTON.open('the file')}</button> : null
    if (fileButton && dispute) now.splice(1, 0, fileButton)
    else if (fileButton) later.push(fileButton)
    if (item.file && inside) later.push(<button key="reveal" className="btn small" onClick={() => void window.damon.revealFile(projectId, item.file!)}>Show in folder</button>)
  }
  const hasDetails = lines.length > 0 || Boolean(item.caution) || Boolean(item.text) || filesListed || later.length > 0
  return (
    <li className={`your-turn-row${cost ? ' costs' : ''}${primary && !editing && !askingWhy ? ' clickable' : ''}${sending ? ' sending' : ''}${stage ? ` stage-${stage}` : ''}`} onClick={primary && !editing && !askingWhy ? () => primary() : undefined}>
      <span className={`your-turn-kind ${item.kind}`}>
        <span className="your-turn-verb">{kindWords(item.kind)}</span>
        {cost ? <span className="your-turn-consequence">{cost}</span> : null}
        {waited ? <span className="your-turn-waited">{waited}</span> : null}
      </span>
      <div className="your-turn-body">
        <h3 className="your-turn-title">{ownerTitle(item)}</h3>
        {generic ? <div className="your-turn-what">{plain}</div> : <p className="your-turn-lead" {...(explainLines(item.what)?.some((l) => /^what to do$/i.test(l.label)) ? { 'data-label': 'what to do' } : {})}>{lead}</p>}
        {(busyLine || waitingLine) && (item.kind === 'submit' || item.kind === 'send') ? <p className="your-turn-busy" role="status">{busyLine ?? waitingLine}{openJob ? <> <button className="btn small" onClick={openJob.open}>{BUTTON.open('Team')}</button></> : null}</p> : null}
        {(question || checkCommands) && plain ? <div className="your-turn-what">{plain}</div> : null}
        {sides.length ? (
          <dl className="your-turn-explain sides">
            {sides.map((l) => (
              <div key={l.label} className="your-turn-explain-row" data-label={l.label.toLowerCase()}>
                <dt>{/^why$/i.test(l.label) ? 'The objection' : l.label}</dt>
                <dd>{l.text}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {sending ? <div className="your-turn-sending">Sending in the team's browser. Leave that window alone for a moment.</div> : null}
        {filling ? <div className="your-turn-sending">Filling the form in the team's browser. Leave that window alone for a few minutes.</div> : null}
        {item.sendFailed && !sending ? <div className="your-turn-failed">{failureForOwner(item.sendFailed)}</div> : null}
        <div className="your-turn-actions" data-stage="now" onClick={stop}>{now}</div>
        {effects ? <><p className="your-turn-effect">{effects.keep}</p><p className="your-turn-effect">{effects.sendBack}</p></> : effect ? <p className="your-turn-effect">{effect}</p> : null}
        {askingWhy ? (
          <div className="your-turn-edit" onClick={stop}>
            <textarea
              value={why}
              rows={3}
              placeholder="What are you not satisfied with? It goes to Damon with the job."
              onChange={(e) => setWhy(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !busy) {
                  e.preventDefault()
                  onSendBack?.(why)
                  setAskingWhy(false)
                }
              }}
            />
            <div className="your-turn-actions left">
              <button className="btn small danger" disabled={busy} onClick={() => { onSendBack?.(why); setAskingWhy(false) }}>Send it back</button>
              <button className="btn small" onClick={() => setAskingWhy(false)}>Cancel</button>
            </div>
          </div>
        ) : null}
        {hasDetails ? (
          <details className="your-turn-more" onClick={stop}>
            <summary>Details</summary>
            {lines.length ? (
              <dl className="your-turn-explain">
                {lines.map((l) => (
                  <div key={l.label} className="your-turn-explain-row" data-label={l.label.toLowerCase()}>
                    <dt>{l.label}</dt>
                    <dd>{l.text}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {plain && !question && !checkCommands && !generic ? <div className="your-turn-what">{plain}</div> : null}
            {item.caution ? <div className="your-turn-caution">{ownerWords(item.caution)}</div> : null}
            {item.text && !editing ? (
              <div>
                <div className={`your-turn-message${long && !whole ? ' folded' : ''}`}>{item.text}</div>
                <div className="your-turn-message-bar">
                  {long ? <button className="linkish is-standalone" onClick={() => setWhole(!whole)}>{whole ? 'Show less' : 'Show the whole message'}</button> : null}
                  {onEdit && !sending ? <button className="linkish is-standalone" onClick={() => { setDraft(item.text ?? ''); setEditing(true) }}>Edit</button> : null}
                  {item.editedAt ? <span className="your-turn-edited">You changed these words.</span> : null}
                </div>
              </div>
            ) : null}
            {editing ? (
              <div className="your-turn-edit">
                <textarea value={draft} rows={5} onChange={(e) => setDraft(e.target.value)} />
                <div className="your-turn-actions left">
                  <button className="btn small primary" disabled={!draft.trim() || draft.trim() === (item.text ?? '').trim()} onClick={() => { onEdit?.(draft); setEditing(false) }}>Save</button>
                  <button className="btn small" onClick={() => setEditing(false)}>Cancel</button>
                </div>
              </div>
            ) : null}
            {filesListed ? (
              <ul className="your-turn-files">
                {item.files!.map((f) => (
                  <li key={f}>
                    <span className="your-turn-file">{f.split('/').pop()}</span>
                    {item.kind === 'submit' && /\.pdf$/i.test(f) ? <span className="your-turn-file-note">the file you send</span> : null}
                    {item.kind === 'submit' && /\.(html?|md)$/i.test(f) && item.files!.some((g) => /\.pdf$/i.test(g) && g.replace(/\.pdf$/i, '').toLowerCase() === f.replace(/\.(html?|md)$/i, '').toLowerCase()) ? <span className="your-turn-file-note">source of the PDF</span> : null}
                    {insideProject(f) && safeToOpen(f) ? <button className="linkish is-standalone" onClick={() => void window.damon.openFile(projectId, f)}>Open</button> : null}
                  </li>
                ))}
                {item.files!.some((f) => insideProject(f)) ? (
                  <li><button className="linkish is-standalone" onClick={() => void window.damon.revealFile(projectId, item.files!.find((f) => insideProject(f))!)}>Show all in folder</button></li>
                ) : null}
              </ul>
            ) : null}
            {later.length ? <div className="your-turn-actions later">{later}</div> : null}
          </details>
        ) : null}
        <div className="your-turn-meta">
          <span>{clock ? `${item.by} · ${clock}` : item.by}</span>
          {item.file && !filesListed ? <span className="your-turn-file">{item.file.split('/').pop()}</span> : null}
        </div>
      </div>
    </li>
  )
}

export async function openTheEmail(projectId: string, id: string, body: string | undefined): Promise<string> {
  try {
    const r = await window.damon.openEmail(projectId, id)
    if (!r.ok) return r.why ?? 'Your computer did not open a new email.'
    if (r.inLink === false) {
      if (body) {
        await navigator.clipboard.writeText(body)
        return 'The words were too long to put in the email for you, so they are copied. Paste them into the email.'
      }
      return 'The words were too long to put in the email for you. Copy them from Details and paste them into the email.'
    }
    return ''
  } catch (e) {
    return errorText(e, 'Your computer did not open a new email.')
  }
}

const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) && !/^Damon\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s)

const CHECK_AGAIN_TITLE = 'Damon runs its own final check on this package again now, on the files as they are. Nothing is sent.'

function OutwardRow({ item, projectId, busy, onDone, onSubmitted, onNotYet, onSendBack, onNotNeeded, onReplaced, onCheckAnyway, onFill, busyLine, waitingLine, openJob, onEdit }: RowProps): JSX.Element {
  const email = isEmailCard(item)
  const emailFile = email ? emailFileOf(item) : null
  const stage = email ? null : submitStage(item)
  const hold = email ? (item.waitingOn ? heldReason(item) : null) : heldReason(item)
  const checkNote = email && !item.waitingOn ? heldReason(item) : null
  const filling = Boolean(item.fillingAt)
  const fillable = !email && Boolean(onFill) && canFill(item) && !hold
  const filled = stage === 'filled' && !hold
  const [out, setOut] = useState<Awaited<ReturnType<typeof window.damon.outgoing>>>(null)
  const [said, setSaid] = useState('')
  const [opening, setOpening] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text ?? '')
  const [askingWhy, setAskingWhy] = useState(false)
  const [why, setWhy] = useState('')
  const [whole, setWhole] = useState(false)
  const filesKey = (item.files ?? []).join('|')
  useEffect(() => {
    if (typeof window.damon?.outgoing !== 'function') return
    let live = true
    window.damon.outgoing(projectId, item.id).then((o) => { if (live) setOut(o ?? null) }).catch(() => { if (live) setOut(null) })
    return () => { live = false }
  }, [projectId, item.id, filesKey, item.at])
  const all = item.files?.length ? item.files : item.file ? [item.file] : []
  const files = outgoingFiles(all, email ? 'attach' : 'upload', out ? out.attachments.filter((a) => a.exists).map((a) => a.file) : undefined, emailFile)
  const goes = files.filter((f) => f.out)
  const attach = goes.filter((f) => f.file !== emailFile)
  const rest = files.filter((f) => !f.out)
  const to = out?.email?.to ?? emailRecipient(item) ?? ''
  const subject = out?.email?.subject ?? (/^\s*subject\s*:\s*(.+)$/im.exec(item.text ?? '')?.[1]?.trim() ?? '')
  const body = out?.email?.body
  const longBody = (body ?? '').length > 600 || (body ?? '').split('\n').length > 8
  const fields = email ? [] : pasteFields(item)
  const checks = beforeYouPress(item)
  const notes = [...cautionNotes(item.caution), ...(item.notes ?? []).filter((n) => !cautionNotes(item.caution).includes(n))]
  const site = safeUrl(item.url)
  const goToSite = site ? (): void => void window.damon.openTeamBrowser(projectId, site) : null
  const canOpen = (f: string): boolean => insideProject(f) && safeToOpen(f)
  const folderFile = [...attach.map((f) => f.file), ...all].find((f) => insideProject(f))
  const stop = (e: ReactMouseEvent): void => e.stopPropagation()
  const claim = email && item.kind === 'send' ? onDone : (onSubmitted ?? onDone)
  const claimLabel = email ? BUTTON.sent : BUTTON.submitted
  const cost = consequenceOf(item)
  const waited = waitedWords(item.at)
  const clock = clockOf(item.at)
  const openEmail = async (): Promise<void> => {
    setOpening(true)
    setSaid('')
    try { setSaid(await openTheEmail(projectId, item.id, body)) } finally { setOpening(false) }
  }

  const names = listWords(attach.map((f) => f.name))
  const failedFill = !email && stage === 'failed' && !hold && item.fillFailed
  const lead = hold
    ? `Not ready: ${lowerFirst(hold)}`
    : email
      ? `Open the email${names ? `, attach ${names}` : ''} and send it from your own mail. Then press ${BUTTON.sent} here.`
      : filled
        ? leadFor(item)
        : failedFill
          ? `Damon could not fill the form: ${lowerFirst(heldSentence(item.fillFailed!))} Press ${BUTTON.fill} to try again, or open the page and submit it by hand.`
          : fillable
            ? `Press ${BUTTON.fill}: Damon fills the form and stops before its Submit button. You check it, press Submit there, then ${BUTTON.submitted} here.`
            : site
              ? `Open the page and submit it by hand with the files in Details. Then press ${BUTTON.submitted} here.`
              : `Submit it by hand with the files in Details. Then press ${BUTTON.submitted} here.`
  const honesty = email
    ? `Damon cannot see your mail, so press ${BUTTON.sent} only once it has gone.`
    : `Damon cannot see what you send, so press ${BUTTON.submitted} only once you have actually sent it.${filled ? ` ${BUTTON.notYet} takes the fill back; ${BUTTON.fill}, under More, starts the form over.` : ''}`

  const claimButton = (primary: boolean): JSX.Element => (
    <button key="claim" className={`btn${primary ? ' primary' : ''}`} disabled={busy || filling} onClick={claim}>{claimLabel}</button>
  )
  let now: JSX.Element[]
  if (email) {
    now = [
      <button key="email" className={`btn${hold ? '' : ' primary'}`} disabled={busy || opening} title={`A new email to ${to} opens in your own mail, with the subject and the words in it. Nothing is sent until you press send there.`} onClick={() => void openEmail()}>{opening ? 'Opening the email…' : BUTTON.open('the email')}</button>,
      claimButton(false)
    ]
  } else if (filled) {
    now = [
      claimButton(true),
      <button key="notyet" className="btn" disabled={busy || filling} title="Nothing is recorded as sent. The fill is taken back and the card stays on your list." onClick={onNotYet}>{BUTTON.notYet}</button>,
      ...(goToSite ? [<button key="site" className="btn" onClick={goToSite}>{BUTTON.open('the form')}</button>] : [])
    ]
  } else if (fillable) {
    now = [
      <button key="fill" className="btn primary" disabled={busy || filling || !!busyLine} onClick={onFill}>{filling ? 'Filling it in…' : BUTTON.fill}</button>,
      claimButton(false),
      ...(goToSite ? [<button key="site" className="btn" disabled={filling} onClick={goToSite}>{BUTTON.open('the page')}</button>] : [])
    ]
  } else {
    now = [claimButton(!hold && !goToSite), ...(goToSite ? [<button key="site" className="btn" onClick={goToSite}>{BUTTON.open('the page')}</button>] : [])]
  }

  const more: JSX.Element[] = [
    ...(onEdit && item.text && !editing ? [<button key="edit" className="btn small" onClick={() => { setDraft(item.text ?? ''); setEditing(true) }}>Edit</button>] : []),
    ...(filled && onFill && canFill(item) ? [<button key="again" className="btn small" disabled={busy || filling || !!busyLine} title="Starts the form over; anything you typed there is lost." onClick={onFill}>{BUTTON.fill}</button>] : []),
    ...(onCheckAnyway && (hold || checkNote || busyLine) ? [<button key="check" className="btn small" disabled={busy || filling} title={busyLine ? CHECK_ANYWAY_TITLE : CHECK_AGAIN_TITLE} onClick={(e) => { e.stopPropagation(); onCheckAnyway() }}>{BUTTON.checkAgain}</button>] : []),
    ...(onReplaced ? [<button key="replaced" className="btn small quiet" disabled={busy} title="Takes this card off your list because a newer card for the same files replaces it. Damon does not take it as sent." onClick={onReplaced}>Replaced by the newer card</button>] : []),
    ...(onNotNeeded ? [<button key="notneeded" className="btn small quiet" disabled={busy} title="Takes this off your list. Damon does not take it as done." onClick={onNotNeeded}>No longer needed</button>] : []),
    ...(onSendBack && !askingWhy ? [<button key="back" className="btn small danger" disabled={busy || filling} title="Tells Damon you are not satisfied. You can say why. The job goes back to the team." onClick={() => setAskingWhy(true)}>{BUTTON.sendBack}</button>] : [])
  ]

  const fileLink = (f: { file: string; name: string }): JSX.Element =>
    canOpen(f.file)
      ? <button className="linkish is-standalone ot-file" title={`Open ${f.name}`} onClick={() => void window.damon.openFile(projectId, f.file)}>{f.name}</button>
      : <span className="ot-file">{f.name}</span>

  return (
    <li className={`your-turn-row ot-row${cost ? ' costs' : ''}${stage ? ` stage-${stage}` : ''}`}>
      <span className={`your-turn-kind ${email ? 'send' : item.kind}`}>
        <span className="your-turn-verb">{kindWords(email ? 'send' : item.kind)}</span>
        {cost ? <span className="your-turn-consequence">{cost}</span> : null}
        {waited ? <span className="your-turn-waited">{waited}</span> : null}
      </span>
      <div className="your-turn-body">
        <h3 className="your-turn-title">{ownerTitle(item)}</h3>
        <p className={`your-turn-lead${hold ? ' ot-not-ready' : ''}`}>{lead}</p>
        {filled && item.fillChecks?.length ? (
          <ul className="ot-fill-checks" aria-label="What Damon read back from the form" onClick={stop}>
            {item.fillChecks.map((c, i) => (
              <li key={`${i}-${c.what}`} data-ok={c.ok ? 'yes' : 'no'}>
                <span aria-hidden="true">{c.ok ? '✓' : '✗'}</span> <strong>{c.what}</strong>{c.ok ? (c.shows ? `: verified, ${c.shows}` : ': verified') : `: not verified, ${c.why ?? 'no reason was given'}`}
              </li>
            ))}
            {item.fillShots?.length ? (
              <li className="ot-fill-shots">Pictures of each part: {item.fillShots.filter((f) => insideProject(f) && safeToOpen(f)).map((f, i) => <button key={f} className="linkish is-standalone" onClick={() => void window.damon.openFile(projectId, f)}>{`Part ${i + 1}`}</button>)}</li>
            ) : null}
          </ul>
        ) : null}
        {item.press ? <p className="your-turn-busy" role="status">{item.press.state === 'waiting' ? `You pressed ${BUTTON.fill} at ${clockOf(item.press.at) || 'a moment ago'}. Your press is kept.` : item.press.why}</p> : null}
        {busyLine || waitingLine ? <p className="your-turn-busy" role="status">{busyLine ?? waitingLine}{openJob ? <> <button className="btn small" onClick={openJob.open}>{BUTTON.open('Team')}</button></> : null}</p> : null}
        {filling ? <div className="your-turn-sending">Filling the form in the team's browser. Leave that window alone for a few minutes.</div> : null}
        <div className="your-turn-actions" data-stage="now" onClick={stop}>{now}</div>
        {email && attach.length ? (
          <p className="ot-attach" onClick={stop}>
            <span>Attach yourself:</span>
            {attach.map((f) => <span key={f.file}>{fileLink(f)}</span>)}
            {folderFile ? <button className="linkish is-standalone" onClick={() => void window.damon.revealFile(projectId, folderFile)}>Show in folder</button> : null}
          </p>
        ) : null}
        {said ? <p className="your-turn-busy" role="status">{said}</p> : null}
        {checkNote ? <p className="your-turn-effect">{checkNote} Read Details before you send it.</p> : null}
        <p className="your-turn-effect">{honesty}</p>
        {askingWhy ? (
          <div className="your-turn-edit" onClick={stop}>
            <textarea value={why} rows={3} placeholder="What are you not satisfied with? It goes to Damon with the job." onChange={(e) => setWhy(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !busy) { e.preventDefault(); onSendBack?.(why); setAskingWhy(false) } }} />
            <div className="your-turn-actions left">
              <button className="btn small danger" disabled={busy} onClick={() => { onSendBack?.(why); setAskingWhy(false) }}>{BUTTON.sendBack}</button>
              <button className="btn small" onClick={() => setAskingWhy(false)}>Cancel</button>
            </div>
          </div>
        ) : null}
        {editing ? (
          <div className="your-turn-edit" onClick={stop}>
            <textarea value={draft} rows={5} onChange={(e) => setDraft(e.target.value)} />
            <div className="your-turn-actions left">
              <button className="btn small primary" disabled={!draft.trim() || draft.trim() === (item.text ?? '').trim()} onClick={() => { onEdit?.(draft); setEditing(false) }}>Save</button>
              <button className="btn small" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : null}
        <details className="your-turn-more ot-details" onClick={stop}>
          <summary>Details</summary>
          <section className="ot-section">
            <h4 className="ot-head">What goes out</h4>
            {goes.length ? null : <p className="ot-held">No file goes out with this card.</p>}
            <dl className="d-defs">
              {goes.map((f) => (
                <div key={f.file} className="d-defrow"><dt>{f.what}</dt><dd>{fileLink(f)}</dd></div>
              ))}
            </dl>
            {folderFile ? <button className="linkish is-standalone" onClick={() => void window.damon.revealFile(projectId, folderFile)}>Show in folder</button> : null}
            {rest.length ? (
              <details className="your-turn-more ot-inner">
                <summary>Other files in the folder ({rest.length})</summary>
                <dl className="d-defs">
                  {rest.map((f) => <div key={f.file} className="d-defrow"><dt>{f.what}</dt><dd>{fileLink(f)}</dd></div>)}
                </dl>
              </details>
            ) : null}
          </section>
          {email || fields.length ? (
            <section className="ot-section">
              <h4 className="ot-head">What to paste</h4>
              <dl className="d-defs">
                {email ? (
                  <>
                    <div className="d-defrow"><dt>To</dt><dd className="ot-value"><span>{to}</span>{to ? <CopyButton text={to} /> : null}</dd></div>
                    <div className="d-defrow"><dt>Subject</dt><dd className="ot-value"><span>{subject || 'No subject line in the email file.'}</span>{subject ? <CopyButton text={subject} /> : null}</dd></div>
                    <div className="d-defrow">
                      <dt>Message</dt>
                      <dd>
                        {body ? (
                          <>
                            <div className={`your-turn-message${longBody && !whole ? ' folded' : ''}`}>{body}</div>
                            <div className="ot-value">
                              <CopyButton text={body} />
                              {longBody ? <button className="linkish is-standalone" onClick={() => setWhole(!whole)}>{whole ? 'Show less' : 'Show the whole message'}</button> : null}
                            </div>
                          </>
                        ) : emailFile ? <span>The words are in {fileLink({ file: emailFile, name: emailFile.split('/').pop() ?? emailFile })}, under the Subject line.</span> : null}
                      </dd>
                    </div>
                  </>
                ) : (
                  fields.map((f) => <div key={f.label} className="d-defrow"><dt>{f.label}</dt><dd className="ot-value"><span>{f.text}</span><CopyButton text={f.text} /></dd></div>)
                )}
              </dl>
            </section>
          ) : null}
          {checks.length ? (
            <section className="ot-section">
              <h4 className="ot-head">Before you press</h4>
              <ul className="ot-checks">{checks.map((c) => <li key={c}>{c}</li>)}</ul>
            </section>
          ) : null}
          {hold || checkNote ? (
            <section className="ot-section">
              <h4 className="ot-head">{hold ? 'Why it’s held' : 'What Damon’s last check said'}</h4>
              <p className="ot-held">{hold ?? checkNote}</p>
            </section>
          ) : null}
          <details className="your-turn-more ot-inner">
            <summary>Damon’s full notes</summary>
            <ul className="ot-notes">{noteLines(item.what).map((l, i) => <li key={i}>{l}</li>)}</ul>
            {item.text && !email ? <ul className="ot-notes">{noteLines(item.text).map((l, i) => <li key={i}>{l}</li>)}</ul> : null}
            {notes.length ? (
              <>
                <h4 className="ot-head">What Damon’s checks noted</h4>
                <ul className="ot-notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
              </>
            ) : null}
            {item.editedAt ? <p className="your-turn-edited">You changed these words.</p> : null}
          </details>
        </details>
        {more.length ? (
          <details className="your-turn-more ot-more" onClick={stop}>
            <summary>More</summary>
            <div className="your-turn-actions left ot-more-actions">{more}</div>
          </details>
        ) : null}
        <div className="your-turn-meta">
          <span>{clock ? `${item.by} · ${clock}` : item.by}</span>
        </div>
      </div>
    </li>
  )
}

function heldSentence(text: string): string {
  const plain = withoutIdsText(ownerWords(failureForOwner(text)))
  const one = (plain.split(/(?<=[.!?])\s+/)[0] ?? plain).trim()
  return /[.!?…]$/.test(one) ? one : `${one}.`
}

export function EscalationCard({ task, onAnswer, onOpenChat }: { task: TaskInfo; onAnswer: (text: string) => Promise<void> | void; onOpenChat: () => void }): JSX.Element {
  const [answer, setAnswer] = useState('')
  const [sending, setSending] = useState(false)
  const why = stuckReason(task.result)
  const submit = async (): Promise<void> => {
    const text = answer.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await onAnswer(text)
      setAnswer('')
    } finally {
      setSending(false)
    }
  }
  return (
    <li className="your-turn-row">
      <span className="your-turn-kind decide"><span className="your-turn-verb">Decide</span></span>
      <div className="your-turn-body">
        <h3 className="your-turn-title">{task.label || task.title}</h3>
        {why ? <div className="your-turn-context">{why}</div> : <div className="your-turn-what">This teammate stopped without saying why, and asked for you.</div>}
        <div className="your-turn-answer">
          <label htmlFor={`stuck-${task.id}`}>Your answer</label>
          <textarea
            id={`stuck-${task.id}`}
            value={answer}
            placeholder="It goes to Damon in the chat, naming this job."
            rows={2}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <button className="btn small primary" disabled={sending || !answer.trim()} onClick={() => void submit()}>
            {sending ? 'Sending your answer…' : 'Send your answer'}
          </button>
        </div>
      </div>
      <div className="your-turn-actions">
        <button className="btn small" onClick={onOpenChat}>
          Open the chat
        </button>
      </div>
    </li>
  )
}

export function stuckReason(result: string | undefined, max = 900): string {
  const plain = (result ?? '')
    .replace(/[*_`#>]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!plain) return ''
  return plain.length > max ? plain.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : plain
}

function Explain({ what }: { what: string }): JSX.Element {
  const lines = explainLines(what)
  if (!lines) return <div className="your-turn-what">{what}</div>
  return (
    <dl className="your-turn-explain">
      {lines.map((l) => (
        <div key={l.label} className="your-turn-explain-row" data-label={l.label.toLowerCase()}>
          <dt>{l.label}</dt>
          <dd>{l.text}</dd>
        </div>
      ))}
    </dl>
  )
}

function CopyButton({ text, primary = false }: { text: string; primary?: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={primary ? 'btn small primary' : 'btn small'}
      title={text.length > 300 ? text.slice(0, 300) + '…' : text}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        })
      }}
    >
      {copied ? 'Copied' : BUTTON.copy}
    </button>
  )
}

export function actsOnYourAccounts(item: YourTurnItem): boolean {
  return consequenceOf(item) !== null
}

export function rankOf(item: YourTurnItem): number {
  if (actsOnYourAccounts(item)) return 3
  if (item.caution) return 2
  return 1
}

export function byWhatItCosts(items: YourTurnItem[]): YourTurnItem[] {
  return [...items].sort((a, b) => {
    const rank = rankOf(b) - rankOf(a)
    if (rank !== 0) return rank
    return a.at < b.at ? -1 : a.at > b.at ? 1 : 0
  })
}

export function waitedWords(at: string, now = Date.now()): string | null {
  const then = Date.parse(at)
  if (Number.isNaN(then)) return null
  const days = Math.floor((now - then) / 86400000)
  if (days < 1) return null
  if (days < 7) return `Waiting ${days} ${days === 1 ? 'day' : 'days'}`
  const weeks = Math.floor(days / 7)
  return `Waiting ${weeks} ${weeks === 1 ? 'week' : 'weeks'}`
}

function clockOf(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}
