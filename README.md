# David the Project Manager

Built by **Makuwerere** at Walk & Hack, the AI Tinkerers NYC × Twilio build-while-you-walk event in Central Park on October 24, 2026. The app was built by texting a coding agent from the park; this repo is the code that came out, packaged so it runs on your own machine.

Voice standup collector. Callers talk to David (Twilio voice webhook), answers are stored as Yesterday / Today / Blockers per person, and a plain-text summary is sent by SMS.

## Run
    pnpm install
    cp .env.example .env     # edit values
    pnpm dev                 # or: pnpm build && pnpm start   (both listen on 0.0.0.0:3000)
    pnpm test

The dashboard at `/` shows settings, today's summary, all updates, the SMS log, and a type-to-talk test call.

## Secrets
`TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` go in `.env.local` (gitignored). They are read only by server code (`vite.config.ts` / `server/`), never sent to the browser. 
`.env.local` also has a blank placeholder, `TWILIO_PHONE_NUMBER`, for the Twilio number that sends SMS and takes calls (E.164, e.g. `+15551234567`; `TWILIO_FROM_NUMBER` is accepted as an alias). If it is blank, the first number on your Twilio account is used. If the account has no number, SMS stay in dry-run mode (logged, not sent) until you buy one at twilio.com/console/phone-numbers and fill it in. No number is ever invented.

Trial accounts can only text numbers verified in the Twilio console. A failed send is logged on the server as a short line (no keys) and shown in the SMS log and summary message as a plain sentence.

## Telegram
Put `TELEGRAM_BOT_TOKEN` (from @BotFather) and `TELEGRAM_CHAT_ID` (channel id like `-1001234567890`, or `@channelname`) in `.env.local`, and add the bot to the channel as an admin. When both are set, the same plain-text summary that goes out by SMS (voice command, auto-send, or "Send summary") is also posted to Telegram, and the "Send to Telegram" button posts it on its own. If either is missing the app says Telegram is not configured and carries on. Both values are read only on the server.

## Configuration (`.env` or environment)
- `TEAM_PHONE_NUMBER`: team number(s) that receive the summary SMS (comma separated, E.164).
- `SUMMARY_RECIPIENTS`: `team`, `callers` (the numbers of people who called in today), or `both`.
- `TWILIO_PHONE_NUMBER`: the SMS sender and number people call (keys are in `.env.local`). If any is missing, SMS run in dry-run mode (logged and shown in the dashboard, not sent).
- `AUTO_SEND_DELAY_SECONDS` (default 120), `TIMEZONE`, `SPEECH_TIMEOUT_SECONDS`, `KNOWN_PEOPLE`, `PUBLIC_BASE_URL`.

## Getting a phone number (Twilio)
1. Buy a voice+SMS number in the Twilio console.
2. Keep `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_PHONE_NUMBER` (that number) in `.env.local`, and put `PUBLIC_BASE_URL` (the https URL of this app) in `.env`.
3. Run the app, then `pnpm phone:setup`. It sets the number's voice webhook to `<PUBLIC_BASE_URL>/voice/incoming` and the status callback to `/voice/status`.
4. The number is printed in the startup output and shown at the top of the dashboard; share it with attendees.
(Manual alternative: set the webhook in the Twilio console.)

## Behaviour
- Each call has its own state keyed by CallSid, so callers can overlap. Phone-to-name links persist in `data/standup.json`.
- Say "send the summary" / "send the standup" at any point to text the summary.
- If no call or update activity occurs for 2 minutes after an update, the summary is sent automatically (once per batch of updates).
- One record per person (phone number) per day: calling again the same day updates that record rather than adding a duplicate.
- Auto-send waits while someone is still answering questions on a call.

`NOTES.md` is the builder's working notes from the event, kept as-is apart from scrubbing a phone number and a chat id. Live Twilio voice was not exercised during the event, so expect to debug the first real call.
