import type { Settings } from './settings.ts'
import { getTwilioClient } from './twilio.ts'

export interface SmsResult {
  to: string
  status: 'sent' | 'dry-run' | 'failed'
  detail?: string
}

/** Split long summaries at blank-line boundaries so each SMS stays under ~1500 chars. */
export function chunkText(text: string, max = 1500): string[] {
  if (text.length <= max) return [text]
  const parts = text.split('\n\n')
  const out: string[] = []
  let cur = ''
  for (const part of parts) {
    if (cur && (cur + '\n\n' + part).length > max) {
      out.push(cur)
      cur = part
    } else cur = cur ? cur + '\n\n' + part : part
  }
  if (cur) out.push(cur)
  return out
}

/**
 * Sends a plain-text SMS with the twilio package, using the account keys from
 * the server environment and a number from the same account as the sender.
 * Without keys (or a from number) it runs in dry-run mode: logged, not sent.
 */
export async function sendSms(settings: Settings, to: string, body: string): Promise<SmsResult> {
  const client = settings.smsConfigured ? getTwilioClient() : null
  if (!client) {
    console.log(`[david] SMS dry-run -> ${to}\n${body}\n`)
    return { to, status: 'dry-run', detail: 'Twilio not configured' }
  }
  try {
    await client.messages.create({ to, from: settings.twilioFromNumber, body })
    return { to, status: 'sent' }
  } catch (err) {
    const e = err as { status?: number; code?: number }
    const hint =
      e.code === 21608 || e.code === 21211
        ? 'trial account: the recipient number must be verified in Twilio'
        : e.code === 21606 || e.code === 21659
          ? 'the sender number cannot send SMS'
          : e.status === 401
            ? 'Twilio rejected the account keys'
            : 'Twilio could not send the message'
    // Short server-side log: no keys, no message body, recipient masked.
    console.error(`[david] SMS to ***${to.slice(-4)} failed (Twilio ${e.status ?? '?'}/${e.code ?? '?'}): ${hint}`)
    return { to, status: 'failed', detail: hint }
  }
}
