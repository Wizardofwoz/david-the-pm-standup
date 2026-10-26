## What this is
David the PM: Twilio voice standup collector + SMS summary. Vite/React dashboard + Node middleware in `server/`.

## Current state
Stage 1 + 2 + phone access implemented. `pnpm test` (5 pass), `pnpm build` ok. SMS is dry-run until Twilio env is set. Not tested against live Twilio.

## Stack & key choices
- API/webhooks run as a Vite plugin (vite.config.ts) so port 3000 serves everything; `pnpm start` = same without Vite.
- Node 22 runs .ts directly (type stripping): imports in server/ and test/ must use `.ts` extensions.
- JSON file store `data/standup.json` (gitignored). Config only via env/.env (server/settings.ts).

## Gotchas & environment facts
- Test without phone: POST form fields to /voice/incoming then /voice/gather (CallSid, From, SpeechResult), or use dashboard simulator.
- Verify: `pnpm test && pnpm exec tsc --noEmit`

- Twilio keys live in `.env.local` (gitignored, server-only). vite.config.ts loads them via loadEnv into process.env; server/settings.ts also reads .env.local for `pnpm start`. SMS/number lookup use the `twilio` package (server/twilio.ts, server/sms.ts). Never import server/ from src/.
- Verified: keys authenticate (account active, type Trial; trial can only text verified numbers). Number var is `TWILIO_PHONE_NUMBER` (alias TWILIO_FROM_NUMBER), blank placeholder in .env.local. TWILIO_PHONE_NUMBER=+15551234567 is set in .env.local, but the Twilio account owns NO numbers (`incomingPhoneNumbers.list()` -> 0, not a verified caller ID either), so real SMS/calls will fail until that number is bought/ported into the account. Webhook to set on it: <PUBLIC_BASE_URL>/voice/incoming (POST), status cb /voice/status. Dev server must be restarted to re-read .env.local (touching vite.config.ts was not enough). The Twilio account has NO phone number yet (startup log: "account has no phone numbers"), so SMS is dry-run and no call number exists. Once one is bought it is auto-discovered as the From/agent number; then set PUBLIC_BASE_URL and run `pnpm phone:setup`.
- pnpm install needs `--store-dir /home/sandbox/.local/share/pnpm/store/v10` here (node_modules was linked from that store).
- Leak check: serve + grep all files for the key values; only .env.local may match (Vite returns 403 for it).
- Same-day repeat caller (same phone) updates the existing record (david.ts ensureUpdate); auto-send is held while any call is mid-questions.

- UI is a light teal theme (src/App.tsx + src/index.css, no CSS framework). The sandbox has no headless browser (`which chromium` -> none), so UI changes can only be checked via build/typecheck and served-asset checks, not screenshots.

- Telegram: server/telegram.ts (Bot API sendMessage, plain text). Vars TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are read from .env.local; reports "not configured" if either is blank. Auto-send won't repost the same text to Telegram if the SMS part fails and retries.
- To restart the dev server from the shell, kill the vite PID found via /proc (don't `pkill -f vite`/loops matching your own command line: it hangs the shell). The supervisor relaunches it.

## Dead ends
none

- Telegram status: TELEGRAM_CHAT_ID=-100123456789 and TELEGRAM_BOT_TOKEN are both set in .env.local; /api/state reports telegramConfigured:true after a dev-server restart. No live sendMessage has been tested yet (bot must be admin in the chat). Check: `grep -c "^TELEGRAM_BOT_TOKEN=.\+" .env.local`.
