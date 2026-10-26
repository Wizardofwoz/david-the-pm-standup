// Production server:  pnpm build && pnpm start
// Serves the built dashboard from dist/ plus the voice webhooks and API.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { banner, createHandler, getDavid, whenReady } from './http.ts'

const dist = resolve(process.cwd(), 'dist')
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
}
const api = createHandler(getDavid())

createServer((req, res) => {
  api(req, res, () => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    let file = normalize(join(dist, urlPath))
    if (!file.startsWith(dist)) file = join(dist, 'index.html')
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html')
    if (!existsSync(file)) {
      res.statusCode = 404
      return res.end('Run `pnpm build` first.')
    }
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream')
    createReadStream(file).pipe(res)
  })
}).listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => void whenReady().then(() => banner(Number(process.env.PORT) || 3000)))
