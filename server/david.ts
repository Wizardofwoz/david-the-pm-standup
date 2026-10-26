import { getSettings, type Settings } from './settings.ts'
import { chunkText, sendSms } from './sms.ts'
import { sendTelegram, TELEGRAM_NOT_CONFIGURED, type TelegramResult } from './telegram.ts'
import { Store, uid, type CallState, type Step, type Update } from './store.ts'

export const GREETING = 'Hi, this is David, the Project Manager.'

export const QUESTIONS = {
  yesterday: 'What did you work on yesterday?',
  today: 'What are you working on today?',
  blockers: 'Any blockers, or anything that didn\'t go well?',
} as const

/** What the HTTP layer should render as TwiML. */
export interface Turn {
  say: string[]
  /** listen for speech after talking */
  gather: boolean
  /** seconds of initial silence before giving up (gather only) */
  waitSeconds?: number
  hangup: boolean
}

const ACKS = ['Got it.', 'Thanks.', 'Okay, noted.', 'Understood.']

// ---------- text helpers ----------

export function cleanAnswer(raw: string): string {
  let t = (raw || '')
    .replace(/\b(um+|uh+|erm+|uhm+|hmm+)\b[,.]?/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim()
  if (!t) return ''
  t = t.charAt(0).toUpperCase() + t.slice(1)
  if (!/[.!?]$/.test(t)) t += '.'
  return t
}

export function normalizeBlockers(text: string): string {
  const t = text.toLowerCase().replace(/[.!,]/g, '').trim()
  if (/^(no|nope|none|nothing|no blockers|nothing really|not really|no nothing|all good|i'?m good|i am good|nah)( at all| right now| today| really)?$/.test(t))
    return 'None.'
  return text
}

export function extractName(raw: string): string {
  let t = (raw || '').trim().replace(/[.!?,]+$/g, '')
  t = t.replace(/^(hi|hello|hey|yeah|yes|sure|okay|ok)[, ]+/i, '')
  t = t.replace(/^(my name is|my name's|the name is|this is|it is|it's|its|i am|i'm|im|call me|they call me|you can call me)\s+/i, '')
  t = t.replace(/\b(speaking|here)$/i, '').trim()
  const words = t.split(/\s+/).filter(Boolean).slice(0, 3)
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export function isSummaryCommand(speech: string): boolean {
  const t = speech.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t || t.split(' ').length > 10) return false
  return /\bsend (out )?(me )?(the |a |our |today'?s )?(daily )?(stand ?up|summary|stand up summary|standup summary)\b/.test(t)
}

export function dateKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

export function prettyDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'long', day: 'numeric' }).format(d)
}

// ---------- engine ----------

export interface SendOutcome {
  ok: boolean
  reason?: string
  text?: string
  recipients?: string[]
  dryRun?: boolean
  failures?: number
  /** Present when Telegram is configured (or was requested directly). */
  telegram?: TelegramResult
}

export class David {
  store: Store
  private sending = false
  /** Last summary text posted to Telegram, so an automatic SMS retry doesn't repost it. */
  private lastTelegramText = ''
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(store = new Store()) {
    this.store = store
  }

  get settings(): Settings {
    return getSettings()
  }

  // ----- call handling -----

  private ack(): string {
    return ACKS[Math.floor(Math.random() * ACKS.length)]
  }

  private ensureUpdate(call: CallState): Update {
    const d = this.store.data
    let u = d.updates.find((x) => x.id === call.updateId)
    // One record per person (phone number) per day: a repeat call updates it in place.
    const today = dateKey(new Date(), this.settings.timezone)
    if (!u) u = d.updates.find((x) => x.phone === call.phone && x.date === today)
    if (u) {
      call.updateId = u.id
      u.callSid = call.sid
      u.complete = false // re-opened until this call finishes the three questions
    }
    if (!u) {
      u = {
        id: uid(),
        date: today,
        callSid: call.sid,
        name: call.name,
        phone: call.phone,
        yesterday: '',
        today: '',
        blockers: '',
        complete: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      d.updates.push(u)
      call.updateId = u.id
    }
    return u
  }

  private question(step: Step): string {
    if (step === 'yesterday' || step === 'today' || step === 'blockers') return QUESTIONS[step]
    return ''
  }

  /** New inbound call. Idempotent per CallSid (Twilio may retry webhooks). */
  incoming(sid: string, from: string): Turn {
    const d = this.store.data
    const s = this.settings
    const existing = d.calls[sid]
    if (existing && existing.step !== 'ask_name' && existing.step !== 'yesterday') {
      return this.resume(existing)
    }
    const known = d.people[from]?.name || s.knownPeople[from] || ''
    const call: CallState = existing || {
      sid,
      phone: from,
      name: known,
      step: known ? 'yesterday' : 'ask_name',
      retries: 0,
      updateId: null,
      active: true,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
    d.calls[sid] = call
    d.meta.lastActivityAt = Date.now()
    this.store.save()
    if (known) {
      return { say: [GREETING, `Good to hear from you, ${known}.`, QUESTIONS.yesterday], gather: true, hangup: false }
    }
    return { say: [GREETING, 'Who do I have the pleasure of speaking with?'], gather: true, hangup: false }
  }

  private resume(call: CallState): Turn {
    if (call.step === 'wrapup') return { say: ['Say send the summary, or you can hang up.'], gather: true, waitSeconds: 5, hangup: false }
    if (call.step === 'done') return { say: ['Goodbye.'], gather: false, hangup: true }
    return { say: [this.question(call.step)], gather: true, hangup: false }
  }

  /** Result of a <Gather>. `speech` is empty when the caller said nothing. */
  async step(sid: string, from: string, speech: string): Promise<Turn> {
    const d = this.store.data
    let call = d.calls[sid]
    if (!call) {
      // Server restarted mid-call or missed the first webhook: start over gracefully.
      this.incoming(sid, from)
      call = d.calls[sid]
    }
    call.updatedAt = Date.now()
    d.meta.lastActivityAt = Date.now()
    const text = (speech || '').trim()

    // Silence
    if (!text) {
      if (call.step === 'wrapup') return this.finish(call, ['No problem. Thanks, ' + (call.name || 'and') + '. Have a great day.'])
      call.retries++
      if (call.retries > 2) {
        return this.finish(call, ["I'm having trouble hearing you. Feel free to call back any time. Goodbye."])
      }
      this.store.save()
      const q = call.step === 'ask_name' ? 'Could I get your name?' : this.question(call.step)
      return { say: ["Sorry, I didn't catch that.", q], gather: true, hangup: false }
    }
    call.retries = 0

    // "Send the summary" works at any point in the call.
    if (isSummaryCommand(text)) {
      const r = await this.sendSummary('voice')
      const said = r.ok
        ? r.dryRun
          ? 'Done. The summary is ready, but text messaging is not configured yet, so nothing was sent.'
          : 'Done. I have texted the standup summary.'
        : `Sorry, I couldn't send it. ${r.reason || ''}`.trim()
      if (call.step === 'wrapup') return this.finish(call, [said, 'Have a great day.'])
      this.store.save()
      const q = call.step === 'ask_name' ? 'Who am I speaking with?' : this.question(call.step)
      return { say: [said, 'Now, ' + q.charAt(0).toLowerCase() + q.slice(1)], gather: true, hangup: false }
    }

    switch (call.step) {
      case 'ask_name': {
        const name = extractName(text)
        if (!name) return { say: ['Sorry, could you tell me your name?'], gather: true, hangup: false }
        call.name = name
        d.people[call.phone] = { phone: call.phone, name }
        call.step = 'yesterday'
        this.store.save()
        return { say: [`Nice to meet you, ${name}.`, QUESTIONS.yesterday], gather: true, hangup: false }
      }
      case 'yesterday':
      case 'today':
      case 'blockers': {
        const u = this.ensureUpdate(call)
        u.name = call.name
        const value = cleanAnswer(text)
        u[call.step] = call.step === 'blockers' ? normalizeBlockers(value) : value
        u.updatedAt = Date.now()
        d.meta.dirty = true
        d.meta.lastActivityAt = Date.now()
        if (call.step === 'yesterday') {
          call.step = 'today'
          this.store.save()
          return { say: [this.ack(), QUESTIONS.today], gather: true, hangup: false }
        }
        if (call.step === 'today') {
          call.step = 'blockers'
          this.store.save()
          return { say: [this.ack(), QUESTIONS.blockers], gather: true, hangup: false }
        }
        u.complete = true
        call.step = 'wrapup'
        this.store.save()
        return {
          say: [
            `Thanks, ${call.name}. Your update is logged.`,
            'If you want the team summary texted right now, say send the summary. Otherwise you can hang up.',
          ],
          gather: true,
          waitSeconds: 6,
          hangup: false,
        }
      }
      case 'wrapup':
        return this.finish(call, [`Okay, thanks ${call.name}. Have a great day.`])
      default:
        return this.finish(call, ['Goodbye.'])
    }
  }

  private finish(call: CallState, say: string[]): Turn {
    call.step = 'done'
    call.active = false
    call.updatedAt = Date.now()
    this.store.data.meta.lastActivityAt = Date.now()
    this.store.save()
    return { say, gather: false, hangup: true }
  }

  /** Twilio status callback (call ended for any reason). */
  callEnded(sid: string) {
    const call = this.store.data.calls[sid]
    if (!call) return
    call.active = false
    call.step = 'done'
    this.store.save()
  }

  // ----- summaries -----

  /** Latest non-empty update per phone number for the given day. */
  updatesFor(date: string): Update[] {
    const byPhone = new Map<string, Update>()
    const sorted = [...this.store.data.updates]
      .filter((u) => u.date === date && (u.yesterday || u.today || u.blockers))
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const u of sorted) byPhone.set(u.phone, u)
    return [...byPhone.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  buildSummary(now = new Date()): { text: string; updates: Update[] } {
    const s = this.settings
    const updates = this.updatesFor(dateKey(now, s.timezone))
    const blocks = updates.map((u) =>
      [
        `${u.name || u.phone}:`,
        `Yesterday: ${u.yesterday || 'Not provided'}`,
        `Today: ${u.today || 'Not provided'}`,
        `Blockers: ${u.blockers || 'Not provided'}`,
      ].join('\n'),
    )
    const text = [`Standup Summary – ${prettyDate(now, s.timezone)}`, ...blocks].join('\n\n')
    return { text, updates }
  }

  async sendSummary(trigger: 'voice' | 'auto' | 'manual'): Promise<SendOutcome> {
    if (this.sending) return { ok: false, reason: 'A summary is already being sent.' }
    this.sending = true
    try {
      const s = this.settings
      const { text, updates } = this.buildSummary()
      if (!updates.length) return { ok: false, reason: 'No updates have been recorded today.' }
      const set = new Set<string>()
      if (s.recipientMode === 'team' || s.recipientMode === 'both') s.teamNumbers.forEach((n) => set.add(n))
      if (s.recipientMode === 'callers' || s.recipientMode === 'both') updates.forEach((u) => u.phone && set.add(u.phone))
      const recipients = [...set].filter(Boolean)

      // Same summary text goes to Telegram too, when it is configured. A Telegram
      // failure is reported but never blocks SMS or causes the SMS to be re-sent.
      const alreadyPosted = trigger === 'auto' && this.lastTelegramText === text
      const telegram: TelegramResult | undefined =
        (s.telegramBotToken || s.telegramChatId) && !alreadyPosted ? await sendTelegram(text) : undefined
      if (telegram?.status === 'sent') this.lastTelegramText = text
      if (telegram?.status === 'sent' && !recipients.length) {
        this.store.data.meta.dirty = false
        this.store.data.meta.lastSummaryAt = Date.now()
        this.store.save()
        return { ok: true, text, recipients, telegram }
      }
      if (!recipients.length) return { ok: false, reason: 'No recipient phone numbers are available. Set TEAM_PHONE_NUMBER.', telegram }

      const chunks = chunkText(text)
      let failures = 0
      let firstFailure = ''
      let dryRun = false
      for (const to of recipients) {
        for (const body of chunks) {
          const r = await sendSms(s, to, body)
          if (r.status === 'failed') {
            failures++
            firstFailure ||= r.detail ? `(${r.detail})` : ''
          }
          if (r.status === 'dry-run') dryRun = true
          this.store.data.sms.push({ id: uid(), to, body, status: r.status, detail: r.detail, trigger, at: Date.now() })
        }
      }
      this.store.data.sms = this.store.data.sms.slice(-100)
      if (failures === 0) {
        this.store.data.meta.dirty = false
        this.store.data.meta.lastSummaryAt = Date.now()
      }
      this.store.save()
      return failures
        ? { ok: false, reason: `${failures} message(s) failed to send. ${firstFailure}`.trim(), text, recipients, failures, telegram }
        : { ok: true, text, recipients, dryRun, telegram }
    } finally {
      this.sending = false
    }
  }

  /** Posts today's summary to Telegram only (the "Send to Telegram" button). */
  async sendTelegramSummary(): Promise<SendOutcome> {
    if (!this.settings.telegramBotToken || !this.settings.telegramChatId) {
      return { ok: false, reason: TELEGRAM_NOT_CONFIGURED, telegram: { status: 'not-configured', detail: TELEGRAM_NOT_CONFIGURED } }
    }
    const { text, updates } = this.buildSummary()
    if (!updates.length) return { ok: false, reason: 'No updates have been recorded today.' }
    const telegram = await sendTelegram(text)
    if (telegram.status === 'sent') this.lastTelegramText = text
    return telegram.status === 'sent'
      ? { ok: true, text, telegram }
      : { ok: false, reason: telegram.detail || 'Telegram could not send the message.', text, telegram }
  }

  // ----- auto send -----

  /** Sends the summary once the line has been quiet for the configured delay. */
  async tick(now = Date.now()) {
    const m = this.store.data.meta
    if (!m.dirty) return
    if (now - m.lastActivityAt < this.settings.autoSendDelaySeconds * 1000) return
    // Don't auto-send while someone is still answering questions (stale calls expire after 10 minutes).
    const live = Object.values(this.store.data.calls).some(
      (c) => c.active && c.step !== 'wrapup' && c.step !== 'done' && now - c.updatedAt < 600_000,
    )
    if (live) return
    console.log('[david] quiet period elapsed, sending standup summary automatically')
    const r = await this.sendSummary('auto')
    if (!r.ok) {
      console.log('[david] auto-send skipped:', r.reason)
      // Don't retry every tick when there is nothing sendable; failed sends do retry next quiet period.
      if (!r.failures) {
        m.dirty = false
        this.store.save()
      } else {
        m.lastActivityAt = now
      }
    }
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick().catch((e) => console.error('[david] tick error', e)), 5000)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
