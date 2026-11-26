import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createEdge } from '../src/edge/index.ts'
import { accountGraph } from '../src/index.ts'
import type { RecordEntry } from '../src/index.ts'
import { fill, read } from '../src/edge/collect.ts'
import { internalsOf } from '../src/client/internals.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const probe = spawnSync('php', ['-r', "exit(extension_loaded('pdo_sqlite') ? 0 : 1);"])
const skip = probe.error ? 'php is not on the PATH' : probe.status !== 0 && 'pdo_sqlite is not loaded'

async function listen(t: TestContext, handler: RequestListener) {
  const server = createServer(handler).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  })
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
}

async function localGraph(t: TestContext, now: () => number = Date.now) {
  const graph = accountGraph({ memory: true, now })
  const edge = createEdge(graph, { token: 'synthetic-wordpress', origins: ['https://site.example.org'], limit: false })
  t.after(async () => {
    await edge.drain()
    await graph.close()
  })
  return { graph, url: await listen(t, edge) }
}

async function wordpress(t: TestContext) {
  const site = await mkdtemp(join(root, '.wordpress-test-'))
  t.after(() => rm(site, { recursive: true, force: true }))
  await copyFile(join(root, 'examples/php/wordpress/account-graph.php'), join(site, 'account-graph.php'))
  const lib = join(site, 'account-graph')
  await mkdir(lib)
  for (const file of ['account_graph_lib.php', 'account_graph_fault.php', 'account_graph_outbox_lib.php', 'account_graph_outbox_pdo.php']) {
    await copyFile(join(root, 'examples/php', file), join(lib, file))
  }
  await copyFile(join(root, 'examples/php/wordpress/account_graph_wordpress.php'), join(lib, 'account_graph_wordpress.php'))
  return async (url: string, command: string, input: Record<string, unknown> = {}) => {
    const args = [join(root, 'test/fixtures/php/wordpress.php'), site, join(site, 'options-' + (input.blog ?? 1) + '.sqlite'), url, command, JSON.stringify(input)]
    const { stdout, stderr } = await promisify(execFile)('php', args, { timeout: 15000, env: { ...process.env, NO_PROXY: '*', no_proxy: '*' } })
    if (command === 'storage-fault') {
      const lines = stderr.trim().split('\n')
      assert.ok(lines.every(line => line === 'Account graph could not persist or update a form job.'))
    } else if (command !== 'inspect' && !input.expect_log) assert.equal(stderr, '')
    return { ...JSON.parse(stdout), stderr }
  }
}

test('the WordPress module tag honors both page lists and keeps the bearer token on the server', { skip }, async t => {
  const run = await wordpress(t)
  const url = await listen(t, (_req, res) => res.end())
  const { shown, schedule } = await run(url, 'pages')
  assert.deepEqual(Object.keys(shown), ['contact'])
  assert.equal(shown.contact[0], 'module')
  assert.equal(shown.contact[1], url + '/collect.js?forms=all')
  assert.ok(!shown.contact[1].includes('synthetic-wordpress'))
  assert.equal(schedule.account_graph_deliver, 'hourly')
  assert.deepEqual(Object.keys((await run(url, 'all-pages')).shown), ['contact', 'private', 'news'])
})

test('CF7 queues valid inquiries on mail failure, never for a form that stores nothing, and a successful mail retry counts once', { skip }, async t => {
  const run = await wordpress(t)
  const { graph, url } = await localGraph(t)
  for (const status of ['validation_failed', 'acceptance_missing', 'spam', 'aborted']) {
    const ignored = await run(url, 'cf7', { status })
    assert.equal(ignored.rows.length, 0)
    assert.deepEqual(ignored.reads, [])
  }
  for (const setting of ['do_not_store', 'demo_mode']) {
    const unstored = await run(url, 'cf7', { cf7_settings: [setting], saved_id: 120 })
    assert.deepEqual([unstored.rows.length, unstored.reads, unstored.singles.length], [0, [], 0], setting)
  }
  const queued = await run(url, 'cf7', { status: 'mail_failed', saved_id: 123 })
  assert.equal(queued.rows.length, 1)
  const subject = JSON.parse(queued.rows[0].option_value).inquiry.subject
  assert.match(subject, /:cf7:23:123$/)
  const sent = await run(url, 'cron')
  const retry = await run(url, 'cf7', { status: 'mail_sent', saved_id: 124 })
  assert.deepEqual(retry.rows, sent.rows)
  await run(url, 'cron')
  const journey = await graph.lookup({ kind: 'journey', subject })
  assert.deepEqual(journey.entries.filter(e => e.kind === 'conversion').map(e => e.stage), ['inquiry'])
})

test('WordPress form hooks queue mapped facts and cron replays an acknowledged graph write with the original key', { skip }, async t => {
  const run = await wordpress(t)
  const { graph, url: graphUrl } = await localGraph(t)
  type FormEntry = Extract<RecordEntry, { type: 'profile' | 'conversion' }>
  const writes: { entry: FormEntry; duplicate: boolean }[] = []
  let lostType = 'profile'
  const url = await listen(t, async (req, res) => {
    const body = await text(req)
    const entries: FormEntry[] = JSON.parse(body).entries
    const result = await fetch(graphUrl + req.url, { method: 'POST', headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' }, body })
    const answer = await result.json()
    for (const [i, entry] of entries.entries()) writes.push({ entry, duplicate: answer.results[i].value?.duplicate })
    if (entries[0]?.type === lostType) return res.writeHead(503).end()
    res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
  })
  assert.equal((await run(url, 'storage-fault')).rows.length, 0)
  const queued = await run(url, 'submit')
  assert.equal(queued.rows.length, 2)
  assert.ok(queued.rows.every((row: any) => row.autoload === 'no'))
  assert.ok(queued.reads.includes('your-email') && queued.reads.includes('your-phone'))
  assert.doesNotMatch(JSON.stringify(queued.rows), /private message|synthetic-wordpress/)
  assert.equal(writes.length, 0)
  const interrupted = await run(url, 'cron')
  assert.equal(JSON.parse(interrupted.rows[0].option_value).last_fault, 'GRAPH.UNAVAILABLE')
  assert.ok(writes.length > 0)
  const committed = writes[0]!
  assert.equal(committed.duplicate, false)
  lostType = 'conversion'
  const halfway = await run(url, 'cron')
  assert.doesNotMatch(halfway.rows[0].option_value, /row17@example\.org|5550142/)
  assert.match(halfway.rows[0].option_value, /inquiry/)
  lostType = ''
  const sent = await run(url, 'cron')
  assert.ok(writes.some(w => w.duplicate && w.entry.key === committed.entry.key))
  assert.ok(writes.some(w => w.duplicate && w.entry.type === 'conversion'))
  for (const replay of writes.filter(w => w.entry.key === committed.entry.key)) assert.deepEqual(replay.entry, committed.entry)
  const accepted = writes.filter(w => !w.duplicate).map(w => w.entry)
  assert.equal(accepted.length, 4)
  assert.deepEqual(accepted.filter(e => e.type === 'profile').map(e => e.facts), [{ email: 'row17@example.org', phone: '+12025550142' }, { email: 'visitor@example.org', phone: '+12025550143' }])
  assert.equal(new Set(accepted.map(e => e.key)).size, 4)
  for (const subject of new Set<string>(accepted.map(e => e.subject))) {
    assert.deepEqual(accepted.filter(e => e.subject === subject).map(e => e.type), ['profile', 'conversion'])
    const { entries } = await graph.lookup({ kind: 'journey', subject })
    assert.deepEqual(entries.filter(e => e.kind === 'conversion').map(e => e.stage), ['inquiry'])
  }
  assert.doesNotMatch(JSON.stringify(sent.rows), /@example\.org|555014[23]/)
  const before = writes.length
  await run(url, 'cron')
  assert.equal(writes.length, before)
  // Re-entry through either plugin in a fresh PHP process must keep both receipts.
  assert.deepEqual((await run(url, 'submit')).rows, sent.rows)
})

// Exercise the collector's submit listener with the module options WordPress enqueued.
function submitAdForm(tag: string, device: string, campaign: string) {
  const inputs: Pick<HTMLInputElement, 'name' | 'value'>[] = []
  const doc = new EventTarget()
  Object.assign(doc, { cookie: 'ag_device=' + device, createElement: () => ({}) })
  const form = {
    closest: () => form,
    getAttribute: (name: string) => name === 'method' ? 'post' : null,
    hasAttribute: () => false,
    querySelector: (selector: string) => inputs.find(input => selector === 'input[name="' + input.name + '"]'),
    append: (input: typeof inputs[number]) => inputs.push(input)
  }
  const url = new URL('https://site.example.org/contact?gclid=click-' + campaign + '&utm_source=google&utm_id=' + campaign + '&creative=ad-' + campaign)
  const previous = new Map(['document', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
    Object.defineProperty(globalThis, 'location', { configurable: true, value: url })
    const visit = read()
    const stop = fill({ all: new URL(tag).searchParams.get('forms') === 'all' })
    // EventTarget sets target itself. A DOM submit event originates on the form.
    Object.assign(doc, { closest: () => form })
    doc.dispatchEvent(new Event('submit'))
    stop()
    return { visit, post: Object.fromEntries(inputs.map(input => [input.name, input.value])) }
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('the device filled by the WordPress tag credits the clicked ad to an inquiry from either form plugin', { skip }, async t => {
  const run = await wordpress(t)
  const now = Date.UTC(2026, 10, 1, 12)
  const { graph, url: base } = await localGraph(t, () => now)
  const { shown } = await run(base, 'pages')
  for (const provider of ['gravity', 'cf7']) {
    const { visit, post } = submitAdForm(shown.contact[1], 'device-' + provider, provider)
    const arrival = await fetch(base + '/collect', { method: 'POST', headers: { origin: 'https://site.example.org' }, body: JSON.stringify(visit) })
    assert.equal(arrival.status, 204)
    const { rows } = await run(base, provider, { post, at: now / 1000 + 1 })
    const job = JSON.parse(rows.at(-1).option_value)
    assert.equal(job.profile.facts.device, visit.device)
    assert.doesNotMatch(rows.at(-1).option_value, /ag_landing|gclid|private message/)
    await run(base, 'cron')
    const subject = job.inquiry.subject
    const journey = await graph.lookup({ kind: 'journey', subject })
    assert.ok(journey.entries.some(e => e.kind === 'sighting' && e.subject === subject && e.kinds.includes('device')))
    const { engine } = await internalsOf(graph)!()
    const { credited } = await engine.graph.attribute(subject, { at: job.inquiry.at })
    assert.deepEqual([credited?.adId, credited?.gclid], ['ad-' + provider, 'click-' + provider])
  }
  const report = await graph.report({ kind: 'campaigns', window: { from: '2026-11-01', to: '2026-11-01', timeZone: 'UTC' } })
  assert.deepEqual(report.value.rows.map(r => [r.campaignId, r.stages.inquiry?.count]).sort(), [['cf7', 1], ['gravity', 1]])
})

test('multisite scopes the same saved entry ID separately for both plugins', { skip }, async t => {
  const run = await wordpress(t)
  const { url } = await localGraph(t)
  const subjects = new Set<string>()
  const keys = new Set<string>()
  for (const blog of [1, 2]) {
    const { rows } = await run(url, 'submit', { blog, saved_id: 123, email: 'site' + blog + '@example.org' })
    assert.equal(rows.length, 2)
    for (const { option_value } of rows) {
      const job = JSON.parse(option_value)
      subjects.add(job.inquiry.subject)
      keys.add(job.inquiry.key)
      keys.add(job.profile.key)
    }
    const drained = await run(url, 'cron', { blog })
    assert.ok(drained.rows.every((r: any) => JSON.parse(r.option_value).state === 'sent'))
  }
  assert.equal(subjects.size, 4)
  assert.equal(keys.size, 8)
})

test('a multisite form map applies plain form IDs to blog 1 and blog-qualified IDs to their own blog', { skip }, async t => {
  const run = await wordpress(t)
  const { url } = await localGraph(t)
  const post = { ag_device: 'other-blog-visitor' }
  const unmapped = await run(url, 'submit', { blog: 4, post })
  assert.deepEqual([unmapped.rows.length, unmapped.reads, unmapped.singles.length], [0, [], 0])
  for (const blog of [1, 3]) {
    const { rows } = await run(url, 'submit', { blog, post })
    assert.deepEqual(rows.map((row: any) => JSON.parse(row.option_value).inquiry.subject.split(':').slice(2, 5).join(':')), [blog + ':gravity:17', blog + ':cf7:23'])
  }
})

test('repeated visitor submissions across requests share an inquiry within ten minutes for both plugins', { skip }, async t => {
  const run = await wordpress(t)
  const url = await listen(t, (_req, res) => res.end())
  for (const [index, provider] of ['gravity', 'cf7'].entries()) {
    const opts = { blog: index + 1 }
    const before = Math.floor(Date.now() / 1000)
    const first = await run(url, provider, { ...opts, id: 123, at: 1793534399 })
    assert.equal(first.rows.length, 1)
    assert.equal(first.deadlines.length, 1)
    assert.ok(first.deadlines[0] >= before + 600 && first.deadlines[0] <= Math.ceil(Date.now() / 1000) + 600)
    const alias = { ...opts, id: 124, ...(provider === 'cf7' ? { saved_id: 124 } : {}) }
    const repeats = await Promise.all([alias, { ...opts, id: 127 }].map(input => run(url, provider, { ...input, at: 1793534401 })))
    for (const repeat of repeats) {
      assert.deepEqual(repeat.rows, first.rows)
      assert.deepEqual(repeat.deadlines, first.deadlines)
    }
    await run(url, 'expire-window', opts)
    const later = await run(url, provider, { ...opts, id: 125, at: 1793535000 })
    assert.equal(later.rows.length, 2)
    const other = await run(url, provider, { ...opts, id: 126, at: 1793535001, email: 'different@example.org' })
    assert.equal(other.rows.length, 3)
    // A saved source entry remains a replay after its short-lived fingerprint expires.
    await run(url, 'expire-window', opts)
    assert.deepEqual((await run(url, provider, alias)).rows, other.rows)
  }
})

test('submissions identified only by a shared browser device stay separate inquiries', { skip }, async t => {
  const run = await wordpress(t)
  const url = await listen(t, (_req, res) => res.end())
  const post = { ag_device: 'kiosk-lobby-1' }
  for (const [id, phone] of [[300, ''], [301, ''], [302, 'call after five']] as const) {
    await run(url, 'gravity', { id, email: '', phone, post })
  }
  const { rows, aliases, deadlines } = await run(url, 'gravity', { id: 302, email: '', phone: 'call after five', post })
  assert.deepEqual(rows.map((row: any) => JSON.parse(row.option_value).inquiry.subject.split(':').at(-1)), ['300', '301', '302'])
  assert.ok(rows.every((row: any) => JSON.parse(row.option_value).profile.facts.device === 'kiosk-lobby-1'))
  assert.deepEqual([aliases.length, deadlines.length], [0, 0])
})

test('enqueues schedule immediate delivery even when the hourly worker is due soon', { skip }, async t => {
  const run = await wordpress(t)
  const { url } = await localGraph(t)
  const before = Math.floor(Date.now() / 1000)
  const queued = await run(url, 'submit')
  assert.equal(queued.singles.length, 1)
  assert.equal(queued.singles[0].hook, 'account_graph_deliver')
  assert.ok(queued.singles[0].due >= before && queued.singles[0].due <= Math.ceil(Date.now() / 1000))
})

test('a worker that finds delivery locked retries in a minute instead of waiting for the hourly pass', { skip }, async t => {
  const run = await wordpress(t)
  const { url } = await localGraph(t)
  await run(url, 'gravity')
  const before = Math.floor(Date.now() / 1000)
  const busy = await run(url, 'cron', { lock_busy: true })
  assert.equal(JSON.parse(busy.rows[0].option_value).state, 'pending')
  assert.deepEqual(busy.singles.map((event: any) => [event.hook, event.args]), [['account_graph_deliver', ['retry']]])
  assert.ok(busy.singles[0].due >= before + 60 && busy.singles[0].due <= Math.ceil(Date.now() / 1000) + 60)
  const free = await run(url, 'cron')
  assert.equal(JSON.parse(free.rows[0].option_value).state, 'sent')
  assert.deepEqual(free.singles, [])
})

test('an hour-old backlog warns once across WordPress requests and resets after recovery', { skip }, async t => {
  const run = await wordpress(t)
  const { url } = await localGraph(t)
  await run(url, 'submit')
  const warn = 'Account graph form worker has a pending job over one hour old.'
  assert.equal((await run(url, 'inspect')).stderr, '')
  await run(url, 'age', { age: 3500 })
  assert.equal((await run(url, 'inspect')).stderr, '')
  await run(url, 'age')
  assert.equal((await run(url, 'inspect')).stderr.trim(), warn)
  assert.equal((await run(url, 'inspect')).stderr, '')
  await run(url, 'cron')
  await run(url, 'gravity', { id: 777, email: 'new@example.org' })
  await run(url, 'age')
  assert.equal((await run(url, 'inspect')).stderr.trim(), warn)
})

test('WordPress logs a parked job once with its reason and keeps submitted values out of the log', { skip }, async t => {
  const run = await wordpress(t)
  const privateDetail = 'private@example.org\nsynthetic-wordpress'
  for (const [index, code] of ['KEY_REUSED', 'INPUT.MALFORMED', privateDetail].entries()) {
    const blog = index + 1
    const url = await listen(t, async (req, res) => {
      const [{ type, key }] = JSON.parse(await text(req)).entries
      const malformed = code === 'INPUT.MALFORMED'
      const fault = { code, message: privateDetail, retryable: false, detail: { path: privateDetail } }
      const results = [{ type, key, ok: false, reason: code, fields: [privateDetail] }]
      res.writeHead(malformed ? 400 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(malformed ? { fault } : { results }))
    })
    await run(url, 'gravity', { blog })
    const parked = await run(url, 'cron', { blog, expect_log: true })
    const { state } = JSON.parse(parked.rows[0].option_value)
    const reason = code === privateDetail ? 'UNKNOWN_REFUSAL' : code
    assert.equal(state, code === 'INPUT.MALFORMED' ? 'failed' : 'refused')
    assert.equal(parked.stderr.trim(), 'Account graph form job ' + state + ' (' + reason + ').')
    assert.doesNotMatch(parked.rows[0].option_value, /example\.org|synthetic-wordpress|5550142/)
    assert.deepEqual((await run(url, 'cron', { blog })).rows, parked.rows)
  }
})

test('cron expires sent receipts and their aliases after 30 days, giving undated receipts a full grace period', { skip }, async t => {
  const run = await wordpress(t)
  const { url } = await localGraph(t)
  for (const [id, email] of [[123, 'first'], [124, 'first'], [125, 'second'], [126, 'second'], [127, 'old-format']] as const) {
    await run(url, 'gravity', { id, email: email + '@example.org' })
  }
  const start = Math.floor(Date.now() / 1000)
  const sent = await run(url, 'cron')
  assert.equal(sent.aliases.length, 2)
  assert.equal(sent.rows.length, 3)
  assert.ok(sent.rows.every((row: any) => JSON.parse(row.option_value).sent_at >= start))
  await run(url, 'age-receipts', { ages: { 123: 31, 125: 29, 127: null } })
  const cleaned = await run(url, 'cron')
  const times = cleaned.rows.map((row: any) => JSON.parse(row.option_value).sent_at)
  assert.equal(times.length, 2)
  assert.ok(times[0] >= start - 29 * 86400 && times[0] < start - 28 * 86400)
  assert.ok(times[1] >= start && times[1] <= Math.ceil(Date.now() / 1000))
  assert.deepEqual(cleaned.aliases, sent.aliases.slice(1))
  assert.deepEqual((await run(url, 'cron')).rows, cleaned.rows)
})

test('the device mapping respects representatives, mismatched form IDs and forms without a device mapping', { skip }, async t => {
  const run = await wordpress(t)
  const { url } = await localGraph(t)
  for (const [index, provider] of ['gravity', 'cf7'].entries()) {
    const blog = index + 1
    const device = 'shared-representative'
    const input = { blog, email: '', phone: '', post: { ag_speaker_device: device, ag_device: 'stale' } }
    const first = await run(url, provider, { ...input, id: 1 })
    const profile = JSON.parse(first.rows[0].option_value).profile
    assert.equal(profile.facts.device, undefined)
    assert.deepEqual(profile.speaker, { device })
    const second = await run(url, provider, { ...input, id: 2 })
    assert.equal(second.rows.length, 2, 'a representative can inquire for different people')
    const wrongId = provider === 'gravity' ? { gform_submit: '999' } : { _wpcf7: '999' }
    const ignored = await run(url, provider, { blog, id: 3, post: { ...wrongId, ag_device: 'wrong-form' } })
    assert.doesNotMatch(ignored.rows.at(-1).option_value, /wrong-form/)
    const omitted = await run(url, provider, { blog, id: 4, email: 'unmapped@example.org', no_device: true, post: { ag_device: 'not-mapped' } })
    assert.doesNotMatch(omitted.rows.at(-1).option_value, /not-mapped/)
    assert.ok((await run(url, 'cron', { blog })).rows.every((r: any) => JSON.parse(r.option_value).state === 'sent'))
  }
})
