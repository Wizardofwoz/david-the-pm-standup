// Server-side only. Never import this from src/ (browser code).
import { getSettings } from './settings.ts'

export const TELEGRAM_NOT_CONFIGURED =
  'Telegram is not configured yet. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env.local.'

export interface TelegramResult {
  status: 'sent' | 'failed' | 'not-configured'
  /** Plain, secret-free sentence suitable for showing in the UI. */
  detail?: string
}

/** Telegram allows 4096 characters per message; split at blank lines to stay under it. */
export function chunkTelegram(text: string, max = 4000): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let cur = ''
  for (const part of text.split('\n\n')) {
    if (cur && (cur + '\n\n' + part).length > max) {
      out.push(cur)
      cur = part
    } else cur = cur ? cur + '\n\n' + part : part
  }
  if (cur) out.push(cur)
  return out.flatMap((c) => (c.length > max ? c.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g')) || [] : [c]))
}

function explain(status: number, description: string): string {
  const d = description.toLowerCase()
  if (status === 401 || status === 404) return 'Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN.'
  if (d.includes('chat not found')) return 'Telegram could not find that chat. Check TELEGRAM_CHAT_ID and add the bot to the channel as an admin.'
  if (status === 403) return 'The bot is not allowed to post in that chat. Add it to the channel as an admin.'
  if (status === 429) return 'Telegram is rate limiting the bot. Try again in a moment.'
  return 'Telegram could not send the message.'
}

/**
 * Posts plain text to the configured Telegram chat/channel with the Bot API
 * `sendMessage` method. Never throws. The token is only used inside the request
 * URL and is never logged or returned.
 */
export async function sendTelegram(text: string): Promise<TelegramResult> {
  const { telegramBotToken: token, telegramChatId: chatId } = getSettings()
  if (!token || !chatId) {
    // Say exactly which variable is missing (names only, never values).
    const missing = [!token && 'TELEGRAM_BOT_TOKEN', !chatId && 'TELEGRAM_CHAT_ID'].filter(Boolean).join(' and ')
    console.error(`[david] Telegram post skipped: ${missing} not set in .env.local`)
    return { status: 'not-configured', detail: TELEGRAM_NOT_CONFIGURED }
  }
  try {
    for (const chunk of chunkTelegram(text)) {
      // No parse_mode: the summary is sent as plain text.
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        let description = ''
        try {
          description = String(((await res.json()) as { description?: string }).description || '')
        } catch {
          /* non-JSON error body */
        }
        const detail = explain(res.status, description)
        console.error(`[david] Telegram post failed (HTTP ${res.status}): ${detail}`)
        return { status: 'failed', detail }
      }
    }
    return { status: 'sent' }
  } catch {
    // Fetch errors can carry the request URL (and so the token); log a fixed message instead.
    console.error('[david] Telegram post failed: could not reach Telegram')
    return { status: 'failed', detail: 'Could not reach Telegram. Try again in a moment.' }
  }
}
