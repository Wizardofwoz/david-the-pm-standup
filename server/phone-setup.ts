// pnpm phone:setup
// Points a number on your Twilio account at this app's voice webhook and prints it.
// Needs the account keys (.env.local) and PUBLIC_BASE_URL (https, reachable by Twilio).
// The number is AGENT_PHONE_NUMBER / TWILIO_PHONE_NUMBER, or else the account's first number.
import { getSettings } from './settings.ts'
import { discoverPhoneNumber, getTwilioClient } from './twilio.ts'

await discoverPhoneNumber()
const s = getSettings()
const client = getTwilioClient()
const missing = [
  !client && 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN (.env.local)',
  !s.publicBaseUrl && 'PUBLIC_BASE_URL',
  !s.agentPhoneNumber && 'a phone number on the Twilio account (or AGENT_PHONE_NUMBER)',
].filter(Boolean)
if (missing.length || !client) {
  console.error('Missing: ' + missing.join(', ') + '. See .env.example.')
  process.exit(1)
}
try {
  const found = (await client.incomingPhoneNumbers.list({ phoneNumber: s.agentPhoneNumber, limit: 1 }))[0]
  if (!found) {
    console.error(`${s.agentPhoneNumber} is not a number on this Twilio account.`)
    process.exit(1)
  }
  await client.incomingPhoneNumbers(found.sid).update({
    voiceUrl: `${s.publicBaseUrl}/voice/incoming`,
    voiceMethod: 'POST',
    statusCallback: `${s.publicBaseUrl}/voice/status`,
    statusCallbackMethod: 'POST',
  })
} catch (err) {
  console.error('Twilio request failed:', (err as { status?: number }).status ?? 'error')
  process.exit(1)
}
console.log(`\nDone. Call David at: ${s.agentPhoneNumber}\nWebhook: ${s.publicBaseUrl}/voice/incoming\n`)
