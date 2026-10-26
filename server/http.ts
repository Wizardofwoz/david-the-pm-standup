import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { David, type Turn } from './david.ts'
import { getSettings, normalizePhone, publicSettings } from './settings.ts'
import { discoverPhoneNumber } from './twilio.ts'

const g = globalThis as unknown as { __david?: David; __ready?: Promise<unknown> }

/** Resolves once the account's phone number has been looked up (so the banner is accurate). */
export const whenReady = () => g.__ready ?? Promise.resolve()

/** Process-wide singleton (survives Vite config reloads without duplicate timers). */
export function banner(port = 3000) {
  const s = getSettings()
  const line = '='.repeat(60)
  console.log(
    [
      line,
      ' David the Project Manager',
      s.agentPhoneNumber
        ? ` CALL DAVID AT: ${s.agentPhoneNumber}`
        : ' Phone number: NOT SET. Buy a number in your Twilio account, then set TWILIO_PHONE_NUMBER in .env.local',
      ` Voice webhook:  ${s.publicBaseUrl ? s.publicBaseUrl + '/voice/incoming' : '(set PUBLIC_BASE_URL) /voice/incoming'}`,
      ` Web dashboard:  ${s.publicBaseUrl || `http://0.0.0.0:${port}`}`,
      ` SMS:            ${
        s.smsConfigured
          ? 'live via ' + s.twilioFromNumber
          : s.twilioAccountSid && s.twilioAuthToken
            ? 'dry-run (Twilio keys loaded, but no TWILIO_PHONE_NUMBER is set and the account has none)'
            : 'dry-run (Twilio keys missing; add them to .env.local)'
      }`,
      ` Summary to:     ${s.teamNumbers.length ? s.teamNumbers.join(', ') : 'callers'} (mode: ${s.recipientMode})`,
      line,
    ].join('\n'),
  )
}

export function getDavid(): David {
  if (g.__david) {
    g.__david.stop()
  } else {
    g.__david = new David()
  }
  g.__david.start()
  g.__ready = discoverPhoneNumber()
  return g.__david
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

export function toTwiml(turn: Turn, actionUrl: string): string {
  const s = getSettings()
  const say = (t: string) => `<Say voice="${esc(s.voice)}">${esc(t)}</Say>`
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>']
  if (turn.gather) {
    // Say lines live inside <Gather> so callers can start talking any time.
    // speechTimeout = seconds of silence that end an answer, so long or
    // rambling answers are not cut off. actionOnEmptyResult lets us re-prompt on silence.
    parts.push(
      `<Gather input="speech" action="${esc(actionUrl)}" method="POST" speechTimeout="${s.speechTimeoutSeconds}" timeout="${turn.waitSeconds ?? 8}" speechModel="phone_call" enhanced="true" actionOnEmptyResult="true" language="en-US">`,
    )
    turn.say.forEach((t) => parts.push(say(t)))
    parts.push('</Gather>')
  } else {
    turn.say.forEach((t) => parts.push(say(t)))
    if (turn.hangup) parts.push('<Hangup/>')
  }
  parts.push('</Response>')
  return parts.join('')
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function validSignature(req: IncomingMessage, params: Record<string, string>): boolean {
  const s = getSettings()
  // Only enforced when we know the public URL and have the auth token.
  if (!s.publicBaseUrl || !s.twilioAuthToken) return true
  const header = String(req.headers['x-twilio-signature'] || '')
  const url = s.publicBaseUrl + (req.url || '')
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url)
  const expected = createHmac('sha1', s.twilioAuthToken).update(data).digest('base64')
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(res: ServerResponse, status: number, type: string, body: string) {
  res.statusCode = status
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}
const json = (res: ServerResponse, status: number, obj: unknown) => send(res, status, 'application/json', JSON.stringify(obj))

/**
 * Connect-style middleware. Handles /voice/* (Twilio webhooks) and /api/*.
 * Calls next() for everything else so Vite / static serving can take over.
 */
export function createHandler(david: David) {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    const path = (req.url || '').split('?')[0]
    if (!path.startsWith('/voice/') && !path.startsWith('/api/')) return next()
    try {
      // ---- Twilio voice webhooks ----
      if (path.startsWith('/voice/')) {
        if (req.method !== 'POST') return send(res, 405, 'text/plain', 'POST only')
        const params = Object.fromEntries(new URLSearchParams(await readBody(req))) as Record<string, string>
        if (!validSignature(req, params)) return send(res, 403, 'text/plain', 'Invalid signature')
        const sid = params.CallSid || 'unknown'
        const from = normalizePhone(params.From || '') || 'unknown'
        if (path === '/voice/incoming') {
          return send(res, 200, 'text/xml', toTwiml(david.incoming(sid, from), '/voice/gather'))
        }
        if (path === '/voice/gather') {
          const turn = await david.step(sid, from, params.SpeechResult || '')
          return send(res, 200, 'text/xml', toTwiml(turn, '/voice/gather'))
        }
        if (path === '/voice/status') {
          if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(params.CallStatus)) david.callEnded(sid)
          return send(res, 204, 'text/plain', '')
        }
        return send(res, 404, 'text/plain', 'Not found')
      }

      // ---- Dashboard / API ----
      if (path === '/api/state' && req.method === 'GET') {
        const d = david.store.data
        const s = getSettings()
        const summary = david.buildSummary()
        return json(res, 200, {
          settings: publicSettings(s),
          people: Object.values(d.people),
          updates: [...d.updates].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100),
          calls: Object.values(d.calls)
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, 20),
          sms: [...d.sms].reverse().slice(0, 20),
          summary: summary.text,
          summaryCount: summary.updates.length,
          autoSend: {
            pending: d.meta.dirty,
            lastActivityAt: d.meta.lastActivityAt,
            lastSummaryAt: d.meta.lastSummaryAt,
            delaySeconds: s.autoSendDelaySeconds,
            now: Date.now(),
          },
        })
      }
      if (path === '/api/summary/send' && req.method === 'POST') {
        const r = await david.sendSummary('manual')
        return json(res, r.ok ? 200 : 400, r)
      }
      if (path === '/api/summary/telegram' && req.method === 'POST') {
        const r = await david.sendTelegramSummary()
        // Only the outcome goes back to the browser: never the token or chat id.
        return json(res, r.ok ? 200 : 400, { ok: r.ok, reason: r.reason, telegram: r.telegram?.status })
      }
      // Browser simulator: drive the same engine the phone webhooks use.
      if (path === '/api/simulate' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { sid?: string; phone?: string; say?: string; start?: boolean }
        const sid = String(body.sid || 'SIM-' + Date.now())
        const phone = normalizePhone(body.phone || '') || '+15550000000'
        const turn = body.start ? david.incoming(sid, phone) : await david.step(sid, phone, String(body.say || ''))
        return json(res, 200, { sid, turn })
      }
      return json(res, 404, { error: 'not found' })
    } catch (err) {
      console.error('[david] request error', err)
      if (path.startsWith('/voice/')) {
        return send(
          res,
          200,
          'text/xml',
          '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, something went wrong on my end. Please call back in a moment.</Say><Hangup/></Response>',
        )
      }
      return json(res, 500, { error: 'internal error' })
    }
  }
}
