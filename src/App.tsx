import { useCallback, useEffect, useRef, useState } from 'react'

interface Update { id: string; date: string; name: string; phone: string; yesterday: string; today: string; blockers: string; complete: boolean; updatedAt: number }
interface Sms { id: string; to: string; status: string; detail?: string; trigger: string; at: number }
interface State {
  settings: { agentPhoneNumber: string | null; teamNumbers: string[]; recipientMode: string; smsSender: string | null; smsConfigured: boolean; telegramConfigured: boolean; autoSendDelaySeconds: number; timezone: string }
  updates: Update[]
  sms: Sms[]
  summary: string
  summaryCount: number
  autoSend: { pending: boolean; lastActivityAt: number; delaySeconds: number; now: number }
}
interface Turn { say: string[]; gather: boolean; hangup: boolean }
interface Line { who: 'david' | 'you'; text: string }

const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json())

const QUESTIONS = [
  { q: 'What did you work on yesterday?', hint: 'Yesterday' },
  { q: 'What are you working on today?', hint: 'Today' },
  { q: "Any blockers or things that didn't go well?", hint: 'Blockers' },
]

const initials = (name: string) =>
  (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('') || '?'

export default function App() {
  const [state, setState] = useState<State | null>(null)
  const [msg, setMsg] = useState('')
  const [sending, setSending] = useState(false)
  const [tgMsg, setTgMsg] = useState('')
  const [tgSending, setTgSending] = useState(false)
  const refresh = useCallback(() => fetch('/api/state').then((r) => r.json()).then(setState).catch(() => {}), [])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [refresh])

  const sendNow = async () => {
    setSending(true)
    try {
      const r = await post('/api/summary/send')
      setMsg(r.ok ? (r.dryRun ? 'Dry run: SMS not configured, logged on server.' : `Sent to ${r.recipients.length} number(s).`) : r.reason)
    } finally {
      setSending(false)
    }
    refresh()
  }

  const sendTelegramNow = async () => {
    setTgSending(true)
    try {
      const r = await post('/api/summary/telegram')
      setTgMsg(r.ok ? 'Posted to Telegram.' : r.reason || 'Telegram could not send the message.')
    } catch {
      setTgMsg('Could not reach the server. Try again.')
    } finally {
      setTgSending(false)
    }
  }

  if (!state)
    return (
      <div className="page">
        <p className="loading" role="status">Loading…</p>
      </div>
    )
  const { settings: s, autoSend: a } = state
  const left = a.pending ? Math.max(0, Math.round((a.lastActivityAt + a.delaySeconds * 1000 - Date.now()) / 1000)) : null
  const live = state.summaryCount > 0

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <span className="logo" aria-hidden="true">D</span>
          <div>
            <h1>David the Project Manager</h1>
            <p className="subtitle">Your team's morning standup, collected by phone.</p>
          </div>
        </div>
        <span className={`pill ${live ? 'pill-live' : 'pill-wait'}`} role="status">
          <span className="dot" aria-hidden="true" />
          {live ? `Live · ${state.summaryCount} ${state.summaryCount === 1 ? 'update' : 'updates'} today` : 'Waiting for updates'}
        </span>
      </header>

      <main className="stack">
        <section className="card about" aria-labelledby="about-h">
          <h2 id="about-h" className="section-title flush">What David does</h2>
          <p className="about-lead">
            David is a project manager voice agent that runs your daily standup. Instead of a meeting, your team just calls in.
          </p>
          <ul className="about-list">
            <li>He greets each caller, then asks three quick questions: what you worked on yesterday, what you're working on today, and any blockers.</li>
            <li>He stores each person's answers, linked to their name and phone number.</li>
            <li>He texts a clean group summary to the team, on request or automatically after the last update.</li>
          </ul>
        </section>

        <section className="card hero" aria-labelledby="call-h">
          <h2 id="call-h" className="eyebrow">Call David</h2>
          {s.agentPhoneNumber ? (
            <p className="phone"><a href={`tel:${s.agentPhoneNumber}`}>{s.agentPhoneNumber}</a></p>
          ) : (
            <p className="notice">No phone number configured yet. Set <code>TWILIO_FROM_NUMBER</code> (or <code>AGENT_PHONE_NUMBER</code>) and run <code>pnpm phone:setup</code>.</p>
          )}
          <p className="muted">Share this number with attendees. Several people can call at once. You can also try David below without a phone.</p>
        </section>

        <section aria-labelledby="q-h">
          <h2 id="q-h" className="section-title">David asks three quick questions</h2>
          <ol className="questions">
            {QUESTIONS.map((x, n) => (
              <li key={x.hint} className="card question">
                <span className="num" aria-hidden="true">{n + 1}</span>
                <div>
                  <span className="tag">{x.hint}</span>
                  <p>{x.q}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="u-h">
          <h2 id="u-h" className="section-title">Updates <span className="count">{state.updates.length}</span></h2>
          {state.updates.length === 0 ? (
            <div className="card empty">
              <p className="empty-title">No updates yet.</p>
              <p className="muted">Call in to add yours.</p>
            </div>
          ) : (
            <ul className="people">
              {state.updates.map((u) => (
                <li key={u.id} className="card person">
                  <div className="person-head">
                    <span className="avatar" aria-hidden="true">{initials(u.name)}</span>
                    <div className="person-id">
                      <h3>{u.name || 'Unknown caller'}</h3>
                      <p className="meta">{[u.phone, u.date].filter(Boolean).join(' · ')}</p>
                    </div>
                    {!u.complete && <span className="badge">In progress</span>}
                  </div>
                  <dl className="fields">
                    <div><dt>Yesterday</dt><dd>{u.yesterday || <span className="none">—</span>}</dd></div>
                    <div><dt>Today</dt><dd>{u.today || <span className="none">—</span>}</dd></div>
                    <div><dt>Blockers</dt><dd>{u.blockers || <span className="none">—</span>}</dd></div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card" aria-labelledby="s-h">
          <h2 id="s-h" className="section-title flush">Today's summary <span className="count">{state.summaryCount}</span></h2>
          <pre className="summary">{state.summary}</pre>
          <div className="actions">
            <button className="btn btn-primary" onClick={sendNow} disabled={!state.summaryCount || sending}>
              {sending ? 'Sending…' : 'Send summary'}
            </button>
            <button className="btn btn-secondary" onClick={sendTelegramNow} disabled={!state.summaryCount || tgSending}>
              {tgSending ? 'Posting…' : 'Send to Telegram'}
            </button>
            <span className="muted" role="status" aria-live="polite">{msg}</span>
          </div>
          <p className="muted tg-status" role="status" aria-live="polite">
            {tgMsg || (s.telegramConfigured ? 'Telegram: connected. Summaries are also posted automatically.' : 'Telegram is not configured yet. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env.local.')}
          </p>
        </section>

        <Simulator onTurn={refresh} />

        <div className="two">
          <section className="card" aria-labelledby="set-h">
            <h2 id="set-h" className="section-title flush">SMS settings</h2>
            <dl className="settings">
              <div><dt>Team phone number</dt><dd>{s.teamNumbers.length ? s.teamNumbers.join(', ') : <em>not set (env TEAM_PHONE_NUMBER)</em>}</dd></div>
              <div><dt>Summary goes to</dt><dd>{s.recipientMode === 'team' ? 'team number' : s.recipientMode === 'callers' ? 'people who called in' : 'team number + callers'}</dd></div>
              <div>
                <dt>SMS sender (Twilio From)</dt>
                <dd>
                  {s.smsSender ?? <em>not set (env TWILIO_FROM_NUMBER)</em>}{' '}
                  {s.smsConfigured ? <span className="badge badge-ok">live</span> : <span className="badge badge-warn">dry-run: messages are only logged</span>}
                </dd>
              </div>
              <div><dt>Auto-send</dt><dd>{s.autoSendDelaySeconds}s after the last update{left !== null ? ` (in ${left}s)` : ' (nothing pending)'}</dd></div>
            </dl>
          </section>

          <section className="card" aria-labelledby="log-h">
            <h2 id="log-h" className="section-title flush">SMS log</h2>
            {state.sms.length === 0 ? (
              <p className="muted">Nothing sent yet.</p>
            ) : (
              <ul className="log">
                {state.sms.map((m) => (
                  <li key={m.id}>
                    <span className="time">{new Date(m.at).toLocaleTimeString()}</span> to {m.to} [{m.trigger}] <b>{m.status}</b>{m.detail ? ` (${m.detail})` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  )
}

/** Type-to-talk test call that uses the same engine as the phone line. */
function Simulator({ onTurn }: { onTurn: () => void }) {
  const [phone, setPhone] = useState('+15551230001')
  const [sid, setSid] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [ended, setEnded] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [lines])

  const apply = (t: Turn) => {
    setLines((l) => [...l, ...t.say.map((text) => ({ who: 'david' as const, text }))])
    if (t.hangup) setEnded(true)
    onTurn()
  }
  const start = async () => {
    const id = 'SIM-' + Date.now()
    setSid(id); setLines([]); setEnded(false)
    apply((await post('/api/simulate', { sid: id, phone, start: true })).turn)
  }
  const say = async () => {
    if (!sid || ended) return
    setLines((l) => [...l, { who: 'you', text: input || '(silence)' }])
    const text = input; setInput('')
    apply((await post('/api/simulate', { sid, phone, say: text })).turn)
  }
  return (
    <section className="card" aria-labelledby="sim-h">
      <h2 id="sim-h" className="section-title flush">Test call (no phone needed)</h2>
      <div className="row">
        <label className="sr-only" htmlFor="sim-phone">Caller phone</label>
        <input id="sim-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="caller phone" inputMode="tel" />
        <button className="btn btn-secondary" onClick={start}>Start call</button>
      </div>
      {lines.length > 0 && (
        <div className="chat" aria-live="polite">
          {lines.map((l, i) => (
            <p key={i} className={`bubble ${l.who}`}><b>{l.who === 'david' ? 'David' : 'You'}</b>{l.text}</p>
          ))}
          <div ref={end} />
        </div>
      )}
      {sid && !ended && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void say() }}>
          <label className="sr-only" htmlFor="sim-say">Your reply</label>
          <input id="sim-say" className="input grow" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Say something…" autoFocus />
          <button className="btn btn-primary">Speak</button>
        </form>
      )}
      {ended && <p className="muted">Call ended.</p>}
    </section>
  )
}
