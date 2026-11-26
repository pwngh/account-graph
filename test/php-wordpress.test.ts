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
  return async (url: string, command: string) => {
    const args = [join(root, 'test/fixtures/php/wordpress.php'), site, join(site, 'options.sqlite'), url, command]
    const { stdout, stderr } = await promisify(execFile)('php', args, { timeout: 15000, env: { ...process.env, NO_PROXY: '*', no_proxy: '*' } })
    if (command === 'storage-fault') {
      const lines = stderr.trim().split('\n')
      assert.ok(lines.every(line => line === 'Account graph could not persist or update a form job.'))
    } else assert.equal(stderr, '')
    return JSON.parse(stdout)
  }
}

test('the WordPress module tag honors both page lists and keeps the bearer token on the server', { skip }, async t => {
  const run = await wordpress(t)
  const url = await listen(t, (_req, res) => res.end())
  const { shown, schedule, other } = await run(url, 'pages')
  assert.deepEqual(Object.keys(shown), ['contact'])
  assert.match(shown.contact, /type=['"]module['"]/)
  assert.ok(shown.contact.includes(url + '/collect.js'))
  assert.ok(!shown.contact.includes('synthetic-wordpress'))
  assert.equal(other, '<script></script>')
  assert.equal(schedule.account_graph_deliver, 'hourly')
  assert.deepEqual(Object.keys((await run(url, 'all-pages')).shown), ['contact', 'private', 'news'])
})

test('WordPress form hooks queue mapped facts and cron replays an acknowledged graph write with the original key', { skip }, async t => {
  const run = await wordpress(t)
  const graph = accountGraph({ memory: true })
  const edge = createEdge(graph, { token: 'synthetic-wordpress', limit: false })
  t.after(async () => { await edge.drain(); await graph.close() })
  const graphUrl = await listen(t, edge)
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
  assert.deepEqual([...new Set(queued.reads)].sort(), ['your-email', 'your-phone'])
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
  // A trusted entry store can replay CF7's hook in a fresh process with the same submission ID.
  const once = await run(url, 'saved-cf7')
  const twice = await run(url, 'saved-cf7')
  assert.equal(once.rows.length, 3)
  assert.deepEqual(twice.rows, once.rows)
  // Core CF7 can accept a second identical form. Its new submission object gets a distinct local entry ID.
  assert.equal((await run(url, 'submit')).rows.length, 4)
})
