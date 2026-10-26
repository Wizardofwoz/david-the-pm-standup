import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { David, extractName, isSummaryCommand } from '../server/david.ts'
import { Store } from '../server/store.ts'

process.env.TEAM_PHONE_NUMBER = '+15559990000'
process.env.TWILIO_ACCOUNT_SID = ''
process.env.TWILIO_AUTH_TOKEN = '' // keep tests offline: never send real SMS
const mk = () => new David(new Store(join(mkdtempSync(join(tmpdir(), 'david-')), 's.json')))

test('name extraction and summary command', () => {
  assert.equal(extractName("it's alice smith"), 'Alice Smith')
  assert.ok(isSummaryCommand('please send the summary'))
  assert.ok(isSummaryCommand('Send the standup.'))
  assert.ok(!isSummaryCommand('I worked on the send summary feature for the report today and yesterday'))
})

test('two concurrent callers, name remembered, summary format', async () => {
  const d = mk()
  const a = d.incoming('A', '+15550000001')
  assert.equal(a.say[0], 'Hi, this is David, the Project Manager.')
  assert.match(a.say[1], /name|speaking/i)
  d.incoming('B', '+15550000002')
  await d.step('A', '+15550000001', 'Alice')
  await d.step('B', '+15550000002', 'my name is Bob')
  await d.step('A', '+15550000001', 'um I fixed the login bug')
  await d.step('B', '+15550000002', 'reviewed PRs')
  await d.step('A', '+15550000001', 'working on search')
  await d.step('B', '+15550000002', 'planning')
  await d.step('A', '+15550000001', 'nope')
  const last = await d.step('B', '+15550000002', 'waiting on design')
  assert.ok(last.gather)
  const { text } = d.buildSummary()
  assert.match(text, /^Standup Summary – \w+ \d+, \d{4}\n\nAlice:\nYesterday: I fixed the login bug\.\nToday: Working on search\.\nBlockers: None\.\n\nBob:/)
  // returning caller is recognised
  const again = d.incoming('C', '+15550000001')
  assert.match(again.say.join(' '), /Alice/)
  assert.equal(again.say.at(-1), 'What did you work on yesterday?')
  const r = await d.sendSummary('manual')
  assert.ok(r.ok && r.dryRun)
  assert.deepEqual(r.recipients, ['+15559990000'])
})

test('auto-send after quiet period', async () => {
  const d = mk()
  d.incoming('A', '+15550000001')
  for (const s of ['Al', 'a', 'b', 'c']) await d.step('A', '+15550000001', s)
  await d.tick(Date.now() + 60_000)
  assert.equal(d.store.data.sms.length, 0)
  await d.tick(Date.now() + 121_000)
  assert.equal(d.store.data.sms.length, 1)
  assert.equal(d.store.data.meta.dirty, false)
})

test('repeat caller updates the same-day record instead of duplicating', async () => {
  const d = mk()
  d.incoming('A', '+15550000001')
  for (const s of ['Al', 'first yesterday', 'first today', 'none']) await d.step('A', '+15550000001', s)
  d.incoming('B', '+15550000001')
  for (const s of ['second yesterday', 'second today', 'a blocker']) await d.step('B', '+15550000001', s)
  assert.equal(d.store.data.updates.length, 1)
  const u = d.store.data.updates[0]
  assert.equal(u.yesterday, 'Second yesterday.')
  assert.equal(u.blockers, 'A blocker.')
  assert.equal(u.name, 'Al')
})

test('no auto-send while a call is still active', async () => {
  const d = mk()
  d.incoming('A', '+15550000001')
  for (const s of ['Al', 'a', 'b']) await d.step('A', '+15550000001', s)
  await d.tick(Date.now() + 200_000)
  assert.equal(d.store.data.sms.length, 0)
  await d.step('A', '+15550000001', 'c')
  await d.tick(Date.now() + 200_000)
  assert.equal(d.store.data.sms.length, 1)
})

test('telegram: not configured is reported, never throws, and does not block SMS', async () => {
  const { sendTelegram, chunkTelegram, TELEGRAM_NOT_CONFIGURED } = await import('../server/telegram.ts')
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_CHAT_ID
  assert.deepEqual(await sendTelegram('hi'), { status: 'not-configured', detail: TELEGRAM_NOT_CONFIGURED })
  const d = mk()
  const none = await d.sendTelegramSummary()
  assert.equal(none.ok, false)
  assert.match(none.reason!, /not configured/i)
  d.incoming('A', '+15550000001')
  for (const s of ['Al', 'a', 'b', 'c']) await d.step('A', '+15550000001', s)
  const r = await d.sendSummary('manual')
  assert.ok(r.ok && r.telegram === undefined)
  const long = Array.from({ length: 300 }, (_, i) => `Person ${i}:\nYesterday: ${'x'.repeat(40)}`).join('\n\n')
  assert.ok(chunkTelegram(long).every((c) => c.length <= 4000))
})

test('telegram: posts the same summary text via sendMessage and hides the token on errors', async () => {
  process.env.TELEGRAM_BOT_TOKEN = '123:TESTTOKEN'
  process.env.TELEGRAM_CHAT_ID = '-100999'
  const calls: { url: string; body: any }[] = []
  const realFetch = globalThis.fetch
  let fail = false
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return fail
      ? new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch
  try {
    const d = mk()
    d.incoming('A', '+15550000001')
    for (const s of ['Al', 'a', 'b', 'c']) await d.step('A', '+15550000001', s)
    const r = await d.sendTelegramSummary()
    assert.ok(r.ok)
    assert.match(calls[0].url, /\/sendMessage$/)
    assert.equal(calls[0].body.chat_id, '-100999')
    assert.equal(calls[0].body.text, d.buildSummary().text)
    assert.equal(calls[0].body.parse_mode, undefined)
    // sendSummary posts to Telegram as well as SMS
    calls.length = 0
    const both = await d.sendSummary('manual')
    assert.equal(both.telegram?.status, 'sent')
    assert.equal(calls.length, 1)
    // failures give a clear, token-free message
    fail = true
    const bad = await d.sendTelegramSummary()
    assert.equal(bad.ok, false)
    assert.match(bad.reason!, /TELEGRAM_CHAT_ID/)
    assert.ok(!JSON.stringify(bad).includes('TESTTOKEN'))
  } finally {
    globalThis.fetch = realFetch
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_CHAT_ID
  }
})
