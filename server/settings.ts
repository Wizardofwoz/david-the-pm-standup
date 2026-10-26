import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * All configuration comes from environment variables (optionally loaded from a
 * `.env` file in the project root; see `.env.example`). Real environment
 * variables win over `.env`.
 */
let loaded = false
function loadDotenv() {
  if (loaded) return
  loaded = true
  // .env.local holds the account's API keys (gitignored, server-side only);
  // real environment variables win, then .env.local, then .env.
  for (const name of ['.env.local', '.env']) {
    const file = resolve(process.cwd(), name)
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file)
      } catch {
        /* ignore malformed file */
      }
    }
  }
}

/** Filled at startup from the Twilio account's own numbers when none is configured. */
export const discovered = { number: '' }

export type RecipientMode = 'team' | 'callers' | 'both'

export interface Settings {
  /** Team phone number(s) that receive the group summary (E.164, comma separated). */
  teamNumbers: string[]
  /** Who receives the summary SMS. */
  recipientMode: RecipientMode
  /** SMS sender: Twilio account + the Twilio number messages are sent FROM. */
  twilioAccountSid: string
  twilioAuthToken: string
  twilioFromNumber: string
  /** The number people dial to reach David (defaults to the Twilio number). */
  agentPhoneNumber: string
  /** True when all three Twilio values are present; otherwise SMS are dry-run (logged only). */
  smsConfigured: boolean
  /** Telegram Bot API credentials (server-only; never sent to the browser). */
  telegramBotToken: string
  telegramChatId: string
  /** Seconds of silence after the last update before the summary is auto-sent. */
  autoSendDelaySeconds: number
  timezone: string
  /** Public https URL of this app; enables Twilio signature validation. */
  publicBaseUrl: string
  /** Twilio <Say> voice. */
  voice: string
  /** Seconds of silence that end a caller's answer. */
  speechTimeoutSeconds: number
  /** phone=Name pairs pre-linking numbers to names. */
  knownPeople: Record<string, string>
}

export function normalizePhone(p: string): string {
  const s = (p || '').trim()
  if (!s) return ''
  const digits = s.replace(/[^\d]/g, '')
  if (!digits) return ''
  if (s.startsWith('+')) return '+' + digits
  if (digits.length === 10) return '+1' + digits
  return '+' + digits
}

export function getSettings(): Settings {
  loadDotenv()
  const e = process.env
  const teamNumbers = (e.TEAM_PHONE_NUMBER || '')
    .split(',')
    .map(normalizePhone)
    .filter(Boolean)
  const mode = (e.SUMMARY_RECIPIENTS || '').toLowerCase()
  const recipientMode: RecipientMode =
    mode === 'team' || mode === 'callers' || mode === 'both'
      ? mode
      : teamNumbers.length
        ? 'team'
        : 'callers'
  const knownPeople: Record<string, string> = {}
  for (const pair of (e.KNOWN_PEOPLE || '').split(',')) {
    const [num, ...name] = pair.split('=')
    const phone = normalizePhone(num || '')
    if (phone && name.length) knownPeople[phone] = name.join('=').trim()
  }
  const twilioAccountSid = e.TWILIO_ACCOUNT_SID || ''
  const twilioAuthToken = e.TWILIO_AUTH_TOKEN || ''
  const twilioFromNumber = normalizePhone(e.TWILIO_PHONE_NUMBER || e.TWILIO_FROM_NUMBER || '') || discovered.number
  return {
    teamNumbers,
    recipientMode,
    twilioAccountSid,
    twilioAuthToken,
    twilioFromNumber,
    agentPhoneNumber: normalizePhone(e.AGENT_PHONE_NUMBER || '') || twilioFromNumber,
    smsConfigured: !!(twilioAccountSid && twilioAuthToken && twilioFromNumber),
    telegramBotToken: (e.TELEGRAM_BOT_TOKEN || '').trim(),
    telegramChatId: (e.TELEGRAM_CHAT_ID || '').trim(),
    autoSendDelaySeconds: Number(e.AUTO_SEND_DELAY_SECONDS) || 120,
    timezone: e.TIMEZONE || 'America/New_York',
    publicBaseUrl: (e.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    voice: e.TTS_VOICE || 'Polly.Matthew-Neural',
    speechTimeoutSeconds: Number(e.SPEECH_TIMEOUT_SECONDS) || 3,
    knownPeople,
  }
}

/** Settings safe to show in the dashboard (no secrets). */
export function publicSettings(s: Settings) {
  return {
    teamNumbers: s.teamNumbers,
    recipientMode: s.recipientMode,
    agentPhoneNumber: s.agentPhoneNumber || null,
    smsSender: s.twilioFromNumber || null,
    smsConfigured: s.smsConfigured,
    // Only a yes/no: the token and chat id never leave the server.
    telegramConfigured: !!(s.telegramBotToken && s.telegramChatId),
    autoSendDelaySeconds: s.autoSendDelaySeconds,
    timezone: s.timezone,
    publicBaseUrl: s.publicBaseUrl || null,
  }
}
