// Server-side only. Never import this from src/ (browser code).
import twilio from 'twilio'
import { discovered, getSettings, normalizePhone } from './settings.ts'

/** Twilio client built from the account keys in the server environment. */
export function getTwilioClient() {
  const s = getSettings()
  if (!s.twilioAccountSid || !s.twilioAuthToken) return null
  return twilio(s.twilioAccountSid, s.twilioAuthToken)
}

/**
 * If no from/agent number is configured, use the first SMS+voice capable number
 * on the caller's own Twilio account. Never throws; logs only a generic message.
 */
export async function discoverPhoneNumber(): Promise<string> {
  const s = getSettings()
  if (s.twilioFromNumber) return s.twilioFromNumber
  const client = getTwilioClient()
  if (!client) return ''
  try {
    const nums = await client.incomingPhoneNumbers.list({ limit: 20 })
    const pick = nums.find((n) => n.capabilities?.sms && n.capabilities?.voice) || nums.find((n) => n.capabilities?.sms) || nums[0]
    discovered.number = pick ? normalizePhone(pick.phoneNumber) : ''
    console.log(discovered.number ? `[david] using Twilio account number ${discovered.number}` : '[david] Twilio account has no phone numbers yet')
  } catch (err) {
    console.error('[david] could not list Twilio numbers:', (err as { status?: number }).status ?? 'error')
  }
  return discovered.number
}
