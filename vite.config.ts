import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { banner, createHandler, getDavid, whenReady } from './server/http.ts'

// David's voice webhooks (/voice/*) and API (/api/*) run inside the same
// process as the dev/preview server, so the single port 3000 serves both the
// dashboard and the Twilio webhooks. `pnpm start` runs the same code without Vite.
// Server-only secrets: .env.local (gitignored) is read here in Node and copied
// into process.env for server code. They are never prefixed VITE_, never
// imported by src/, and never sent to the browser.
function loadServerSecrets(mode: string) {
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    if (env[key] && !process.env[key]) process.env[key] = env[key]
  }
}

function davidServer(): Plugin {
  return {
    name: 'david-server',
    config(_, { mode }) {
      loadServerSecrets(mode)
    },
    configureServer(server) {
      const david = getDavid()
      server.middlewares.use(createHandler(david))
      server.httpServer?.on('close', () => david.stop())
      server.httpServer?.once('listening', () => void whenReady().then(() => banner(3000)))
    },
    configurePreviewServer(server) {
      server.middlewares.use(createHandler(getDavid()))
    },
  }
}

// The preview is served through Traefik on a per-sandbox host
// (s-<id>-3000.preview.<domain>), so the dev server must listen on all
// interfaces and accept that forwarded Host header.
export default defineConfig({
  plugins: [react(), davidServer()],
  server: {
    host: true,
    port: 3000,
    strictPort: true,
    allowedHosts: true,
    // runtime data must not trigger reloads
    watch: { ignored: ['**/data/**'] },
  },
})
