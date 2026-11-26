import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { TestContext } from 'node:test'
import { format } from 'node:util'
import { internalsOf } from '../src/client/internals.ts'
import type { AccountGraph } from '../src/contract/api.ts'
import { email, hashPhone } from '../src/core/identifiers.ts'
import { namedKeys } from '../src/core/names.ts'
import { createEdge } from '../src/edge/index.ts'
import type { EdgeOptions } from '../src/edge/index.ts'

const marker = 'transcript-must-disappear-c48bd341'
const chat = {
  kind: 'lead', secret: 'chat-only-test-key'.repeat(2), trustSubjects: true, auth: { header: 'X-Chat-Proof', encoding: 'hex' },
  mapping: { id: 'envelope.ticket', at: 'envelope.when', subject: 'envelope.account', email: 'visitors.1.mail', phone: 'visitors[1].number', first: 'visitors[1].given', last: 'visitors.1.family', device: 'hidden.ag_device' },
} as const
const intake = {
  kind: 'lead', secret: 'intake-only-test-key'.repeat(2), auth: { header: 'X-Intake-Proof', encoding: 'base64' },
  mapping: { id: 'submission', device: 'ag_device' }, prefix: 'application', stage: 'submitted',
} as const
const payment = {
  kind: 'payment', secret: 'payment-only-test-key'.repeat(2), auth: 'bearer', conversions: ['lead:chat'], maxAmount: 1000, mapping: { id: 'reference', amount: 'total', currency: 'iso', conversion: 'invoice' },
} as const
const limited = {
  kind: 'lead', secret: 'limited-only-test-key'.repeat(2), auth: 'bearer', mapping: { id: 'ticket', device: 'browser' }, perMinute: 1,
} as const
export const leadSources = { chat, intake, payment, limited }

const newLead = { recorded: ['profile', 'conversion'], duplicate: false }
const duplicate = { recorded: [], duplicate: true }
const ignored = { recorded: [], note: 'NO_FACT_USED' }
const forgotten = { recorded: [], note: 'FORGOTTEN' }
const sign = (source: typeof chat | typeof intake, raw: string | Buffer) => ({ [source.auth.header]: createHmac('sha256', source.secret).update(raw).digest(source.auth.encoding) })
const bearer = (token: string) => ({ authorization: 'Bearer ' + token })

export async function leadRoutes(t: TestContext, graph: AccountGraph, clock: { at: number }, dump: () => Promise<string>) {
  const { engine, options } = await internalsOf(graph)!()
  const logs = (['info', 'error', 'warn', 'log'] as const).map(method => t.mock.method(console, method, () => {}))
  let edge = createEdge(graph, { token: 'service' })
  const server = createServer((req, res) => edge(req, res)).listen(0, '127.0.0.1')
  await new Promise<void>((done, fail) => server.once('listening', done).once('error', fail))
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const post = (name: string, raw: string | Buffer | Buffer[], headers: Record<string, string | string[]> = {}, type = 'application/json') =>
    new Promise<{ status: number, body: unknown }>((done, fail) => {
      const req = request(base + '/leads/' + name, { method: 'POST', headers: { 'content-type': type, ...headers } }, res => {
        const parts: Buffer[] = []
        res.on('error', fail).on('data', part => parts.push(part)).on('end', () => {
          try {
            const body = Buffer.concat(parts).toString()
            assert.ok(!body.includes(marker), 'the response exposed the transcript')
            done({ status: res.statusCode!, body: body ? JSON.parse(body) : null })
          } catch (error) {
            fail(error)
          }
        })
      }).on('error', fail)
      if (Array.isArray(raw)) {
        for (const part of raw) req.write(part)
        req.end()
      } else req.end(raw)
    })
  const sendChat = (raw: string) => post('chat', raw, sign(chat, raw))
  const sendIntake = (raw: string) => post('intake', raw, sign(intake, raw), 'application/x-www-form-urlencoded')
  const sendPayment = (reference: string, invoice: string, total = '12.50') => post('payment', JSON.stringify({ reference, invoice, total, iso: 'usd', note: marker }), bearer(payment.secret))
  const at = clock.at - 100_000
  const subject = 'account:existing'
  const key = 'lead:chat:one'
  const address = 'contact17@example.org'
  const number = '+12025550117'
  const given = 'Vemquilli'
  const family = 'Kifzara'
  const fields = { envelope: { ticket: 'one', when: at, account: subject }, visitors: [{ mail: 'decoy@example.org' }, { mail: address, number, given, family }], hidden: { ag_device: 'widget-device' }, transcript: marker, note: 'é' }
  const raw = JSON.stringify(fields, null, 2)
  const before = await engine.graph.counts()
  const firstEvents = await graph.events({ after: null, limit: 100 })
  try {
    assert.equal((await post('absent', raw)).status, 404)
    assert.equal((await post('constructor', raw)).status, 404)
    assert.equal((await post('chat', raw)).status, 401)
    assert.equal((await post('chat', raw, bearer(chat.secret))).status, 401)
    assert.equal((await post('chat', raw, { 'X-Chat-Proof': '0'.repeat(64) })).status, 401)
    const proof = sign(chat, raw)['X-Chat-Proof']!
    assert.equal((await post('chat', raw, { 'X-Chat-Proof': [proof, proof] })).status, 401)
    assert.equal((await post('chat', raw, { 'X-Chat-Proof': sign(chat, raw)['X-Chat-Proof'] + '!' })).status, 401)
    assert.equal((await post('chat', raw.replace('"one"', '"another"'), sign(chat, raw))).status, 401)
    assert.equal((await post('chat', JSON.stringify(fields), sign(chat, raw))).status, 401)
    assert.equal((await fetch(base + '/leads/chat')).status, 405)
    const invoice = JSON.stringify({ reference: 'unauthorized', invoice: key, total: 1, iso: 'USD' })
    for (const token of ['service', chat.secret]) assert.equal((await post('payment', invoice, bearer(token))).status, 401)
    assert.equal((await post('payment?secret=' + payment.secret, invoice)).status, 401)
    for (const unreadable of ['[]', '{"note":"' + marker + '" BAD', '{}']) assert.equal((await sendChat(unreadable)).status, 400)
    assert.equal((await post('chat', raw, sign(chat, raw), 'text/plain')).status, 400)
    assert.equal((await sendIntake('submission=bad&ag_device=%GG')).status, 400)
    const invalidUtf8 = Buffer.concat([Buffer.from('{"envelope":{"ticket":"bad"},"note":"'), Buffer.from([0xff]), Buffer.from('"}')])
    assert.equal((await post('chat', invalidUtf8, sign(chat, invalidUtf8.toString()))).status, 401)
    assert.equal((await post('chat', invalidUtf8, sign(chat, invalidUtf8))).status, 400)
    const fill = Buffer.alloc(65_536, 'a')
    const tooLarge = [fill, Buffer.from('x')]
    assert.equal((await post('chat', tooLarge, sign(chat, Buffer.concat(tooLarge)))).status, 413)
    assert.deepEqual(await engine.graph.counts(), before)
    assert.deepEqual(await graph.events({ after: null, limit: 100 }), firstEvents)

    // A usable id alone, or a mailbox the graph declines to use, cannot leave an orphan conversion.
    for (const visitors of [[], [{}, { mail: 'office@example.org' }]]) {
      assert.deepEqual(await sendChat(JSON.stringify({ envelope: { ticket: 'empty' }, visitors })), { status: 200, body: ignored })
    }
    assert.equal(await engine.graph.outcomeOf('lead:chat:empty'), undefined)
    assert.deepEqual(await engine.graph.counts(), before)
    const corrected = JSON.stringify({ envelope: { ticket: 'empty' }, hidden: { ag_device: 'corrected' } })
    assert.deepEqual(await sendChat(corrected), { status: 200, body: newLead })
    const exactLimit = JSON.stringify({ envelope: { ticket: 17, when: new Date(at).toISOString() }, hidden: { ag_device: 'boundary' }, visitors: [{}, { mail: 'invalid', number: 'invalid' }] }).padEnd(65_536)
    assert.deepEqual(await sendChat(exactLimit), { status: 200, body: newLead })
    assert.equal((await engine.graph.outcomeOf('lead:chat:17'))?.at, at)
    for (const envelope of [{ ticket: 17.5 }, { ticket: 'bad/id' }, { ticket: 'x'.repeat(129) }, { ticket: 17, when: '2026-11-25T09:00:00' }, { ticket: 'bad-day', when: '2026-02-30T09:00:00Z' }]) {
      assert.equal((await sendChat(JSON.stringify({ envelope, hidden: { ag_device: 'boundary' } }))).status, 400)
    }
    assert.deepEqual(await sendChat(raw), { status: 200, body: newLead })
    const saved = await engine.graph.outcomeOf(key)
    assert.deepEqual([saved?.at, saved?.stage, saved?.subject], [at, 'inquiry', subject])
    const ids = (await engine.store.read(tx => tx.edgesOf([subject]))).map(row => row.identifier)
    const contacts = [email(address), 'phone:' + hashPhone(number)] as const
    const names = namedKeys(options.identifierSecret!, contacts, given, family)
    assert.ok(names.length > 0)
    for (const id of [...contacts, ...names, 'device:widget-device']) assert.ok(ids.includes(id), id)
    assert.ok(!ids.includes(email('decoy@example.org')))
    assert.deepEqual(await sendChat(raw.replace(marker, 'another ignored transcript')), { status: 200, body: duplicate })

    // The same source id cannot be reassigned to somebody else through a corrected vendor payload.
    assert.equal((await sendChat(raw.replace(subject, 'account:changed'))).status, 409)
    assert.equal((await engine.graph.outcomeOf(key))?.subject, subject)
    const seeded = await graph.record({ entries: [{ type: 'conversion', key: 'lead:chat:collision', at, stage: 'prior', subject: 'account:other' }] })
    assert.ok(seeded.results[0]!.ok)
    assert.equal((await sendChat(JSON.stringify({ envelope: { ticket: 'collision', when: at }, hidden: { ag_device: 'stray' } }))).status, 409)
    assert.deepEqual(await engine.store.read(tx => tx.edgesOf(['lead:chat:collision'])), [])

    const form = 'submission=one&ag_device=form%2Ddevice&note=' + marker
    const formHeaders = sign(intake, form)
    assert.equal((await post('intake', form.replace('%2D', '-'), formHeaders, 'application/x-www-form-urlencoded')).status, 401)
    assert.equal((await post('intake', form, { 'X-Intake-Proof': formHeaders['X-Intake-Proof'] + '!' }, 'application/x-www-form-urlencoded')).status, 401)
    assert.deepEqual(await sendIntake(form), { status: 200, body: newLead })
    const submitted = await engine.graph.outcomeOf('lead:intake:one')
    assert.deepEqual([submitted?.stage, submitted?.subject, submitted?.at], ['submitted', 'application:one', clock.at])
    assert.ok((await engine.store.read(tx => tx.edgesOf(['application:one']))).some(edge => edge.identifier === 'device:form-device'))
    // A retry through a fresh handler still uses the timestamp on the original receipt.
    edge = createEdge(graph, { token: 'service' })
    clock.at += 1000
    assert.deepEqual(await sendIntake(form), { status: 200, body: duplicate })
    const race = await Promise.all([sendIntake(form.replace('one', 'race')), sendIntake(form.replace('one', 'race'))])
    assert.deepEqual(race.map(row => row.status), [200, 200])
    assert.deepEqual(new Set(race.map(row => row.body)), new Set([newLead, duplicate]))

    const paidAt = clock.at
    assert.deepEqual(await sendPayment('paid', key), { status: 200, body: { recorded: ['payment'], duplicate: false } })
    const replay = (await graph.record({ entries: [{ type: 'payment', key: 'lead:payment:paid', at: paidAt, amount: 12.5, currency: 'USD', direction: 'received', conversion: key }] })).results[0]!
    assert.ok(replay.ok && replay.value.duplicate)
    clock.at += 1000
    assert.deepEqual(await sendPayment('paid', key), { status: 200, body: duplicate })
    const paid = await engine.graph.outcomeOf(key)
    assert.deepEqual([paid?.value, paid?.currency], [12.5, 'USD'])
    assert.equal((await sendPayment('paid', key, '29')).status, 409)
    assert.equal((await engine.graph.outcomeOf(key))?.value, 12.5)
    for (const wrong of [{ total: 0 }, { total: '12 dollars' }, { iso: 'dollars' }, { invoice: null }]) {
      const raw = JSON.stringify({ reference: 'invalid', invoice: key, total: 1, iso: 'USD', ...wrong })
      assert.equal((await post('payment', raw, bearer(payment.secret))).status, 400)
    }

    const retained = await dump()
    assert.ok(retained.includes(key), 'the search must see the stored conversion')
    assert.ok(!retained.includes(marker), 'the store retained the transcript')
    assert.ok(!retained.includes(chat.secret), 'the store retained the source secret')
    assert.ok((await graph.forget({ subjects: [subject], key: 'erase-one', at: clock.at, by: 'operator', platforms: 'report' })).ok)
    assert.deepEqual(await sendChat(raw), { status: 200, body: forgotten })
    assert.deepEqual(await sendPayment('paid', key), { status: 200, body: forgotten })
    assert.deepEqual(await sendPayment('later', key), { status: 200, body: forgotten })
    assert.equal(await engine.graph.outcomeOf(key), undefined)
    assert.deepEqual(await engine.store.read(tx => tx.edgesOf([subject])), [])

    const vendor = (ticket: string) => JSON.stringify({ ticket, browser: 'vendor-device' })
    assert.equal((await post('limited', vendor('first'))).status, 401)
    assert.deepEqual(await post('limited', vendor('first'), bearer(limited.secret)), { status: 200, body: newLead })
    assert.equal((await engine.graph.outcomeOf('lead:limited:first'))?.subject, 'lead:limited:first')
    assert.equal((await post('limited', vendor('next'), bearer(limited.secret))).status, 429)
    assert.equal(await engine.graph.outcomeOf('lead:limited:next'), undefined)
    assert.deepEqual(await sendIntake(form), { status: 200, body: duplicate })
    clock.at += 60_000
    assert.deepEqual(await post('limited', vendor('next'), bearer(limited.secret)), { status: 200, body: newLead })

    edge = createEdge(graph, { token: 'service', leads: { widget: { ...limited, mapping: { id: 'ticket.id', email: 'contacts.1.mail', device: 'browsers[0]' } } } })
    assert.equal((await sendChat(raw)).status, 404)
    const nested = new URLSearchParams([['ticket[id]', 'a'], ['contacts[1][mail]', address], ['browsers[]', 'first-device'], ['browsers[]', 'second-device']]).toString()
    const widget = (raw: string) => post('widget', raw, bearer(limited.secret), 'application/x-www-form-urlencoded')
    assert.equal((await widget('ticket=%fe')).status, 400)
    clock.at += 60_000
    assert.deepEqual(await widget(nested), { status: 200, body: newLead })
    const widgetIds = (await engine.store.read(tx => tx.edgesOf(['lead:widget:a']))).map(row => row.identifier)
    assert.ok(widgetIds.includes(email(address)) && widgetIds.includes('device:first-device') && !widgetIds.includes('device:second-device'))

    await graph.close()
    edge = createEdge(graph, { token: 'service' })
    assert.equal((await post('absent', raw)).status, 404)
    assert.equal((await post('chat', raw)).status, 401)
    assert.equal((await sendChat(raw)).status, 503)
    // A lead with nothing to record is answered the same whether or not the graph is up.
    assert.deepEqual(await sendChat('{"envelope":{"ticket":"empty"}}'), { status: 200, body: ignored })
    // Errors take the shape of every route outside /v1.
    for (const answer of [await sendChat(raw), await post('chat', raw), await post('absent', raw), await sendChat('[]'), await post('chat', [Buffer.alloc(65_537)], sign(chat, Buffer.alloc(65_537)))]) {
      assert.deepEqual(Object.keys(answer.body as object), ['error'])
      assert.equal(typeof (answer.body as { error: unknown }).error, 'string')
    }
    assert.ok(!logs.flatMap(log => log.mock.calls.map(call => format(...call.arguments))).join('\n').includes(marker), 'the log exposed the transcript')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
}

/** An edge with its own lead sources on a loopback port. */
export async function leadServer(graph: AccountGraph, options: Omit<EdgeOptions, 'token'> = {}) {
  const edge = createEdge(graph, { token: 'service', ...options })
  const server = createServer((req, res) => edge(req, res)).listen(0, '127.0.0.1')
  await new Promise<void>((done, fail) => server.once('listening', done).once('error', fail))
  const port = (server.address() as AddressInfo).port
  const post = async (name: string, raw: string, headers: Record<string, string> = {}, type = 'application/json') => {
    const response = await fetch(`http://127.0.0.1:${port}/leads/${name}`, { method: 'POST', body: raw, headers: { 'content-type': type, ...headers } })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) as unknown : null, retry: response.headers.get('retry-after') }
  }
  const close = async () => {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  return { port, post, close }
}

const formType = 'application/x-www-form-urlencoded'

export async function leadSubjects(graph: AccountGraph, at: number) {
  const { engine } = await internalsOf(graph)!()
  const form = { kind: 'lead', secret: 'public-form-relay-secret'.repeat(2), auth: 'bearer', prefix: 'intake', mapping: { id: 'submission_ref', subject: 'contact_ref', phone: 'callback_line', email: 'mail' } } as const
  const office = { ...form, secret: 'office-system-relay-secret'.repeat(2), prefix: 'office', trustSubjects: true } as const
  const victim = 'contact:28'
  assert.ok((await graph.record({ entries: [{ type: 'profile', key: 'seed-28', at, subject: victim, facts: { email: 'client28@example.org' } }] })).results[0]!.ok)
  const served = await leadServer(graph, { leads: { form, office } })
  const send = (name: 'form' | 'office', fields: Record<string, string>) => served.post(name, new URLSearchParams(fields).toString(), bearer((name === 'form' ? form : office).secret), formType)
  const idsOf = async (subject: string) => (await engine.store.read(tx => tx.edgesOf([subject]))).map(row => row.identifier)
  try {
    // A visitor edits the hidden field to name somebody else's record.
    for (const contact_ref of [victim, 'lead:chat:C1', 'office:7', 'intake', 'intake:', 'intake:a b', 'intakes:1']) {
      assert.equal((await send('form', { submission_ref: 'X1', contact_ref, mail: 'visitor@example.org', callback_line: '+12025550199' })).status, 400, contact_ref)
    }
    assert.equal(await engine.graph.outcomeOf('lead:form:X1'), undefined)
    assert.ok(!(await idsOf(victim)).includes(email('visitor@example.org')))
    assert.deepEqual(await send('form', { submission_ref: 'X2', contact_ref: 'intake:client-5', mail: 'visitor@example.org' }), { status: 200, body: newLead, retry: null })
    assert.equal((await engine.graph.outcomeOf('lead:form:X2'))?.subject, 'intake:client-5')
    assert.deepEqual(await send('form', { submission_ref: 'X3', mail: 'other@example.org' }), { status: 200, body: newLead, retry: null })
    assert.equal((await engine.graph.outcomeOf('lead:form:X3'))?.subject, 'intake:X3')
    // A sender trusted with every record can still name one.
    assert.deepEqual(await send('office', { submission_ref: 'O1', contact_ref: victim, mail: 'second28@example.org' }), { status: 200, body: newLead, retry: null })
    assert.ok((await idsOf(victim)).includes(email('second28@example.org')))
  } finally {
    await served.close()
  }
}

export async function leadOversize(graph: AccountGraph) {
  const signed = { kind: 'lead', secret: 'oversize-check-secret'.repeat(2), auth: { header: 'X-Proof', encoding: 'hex' }, mapping: { id: 'id', email: 'mail' } } as const
  const served = await leadServer(graph, { leads: { signed } })
  try {
    // An unsigned chunked post that never ends, from a sender that reads its answer only a moment later:
    // the server answers 413, stops reading and closes the connection, and the answer is not lost to a reset.
    for (const wait of [0, 300]) {
      const { reply, sent, closed } = await new Promise<{ reply: string, sent: number, closed: boolean }>(done => {
        let reply = ''
        let sent = 0
        const chunk = Buffer.alloc(16_384, 'a')
        const socket = connect(served.port, '127.0.0.1', () => {
          socket.write(`POST /leads/signed HTTP/1.1\r\nHost: graph.example.org\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nX-Proof: ${'0'.repeat(64)}\r\n\r\n`)
          const pump = setInterval(() => {
            for (let i = 0; i < 16 && socket.writable && !socket.writableNeedDrain; i++) {
              socket.write(`${chunk.length.toString(16)}\r\n`)
              socket.write(chunk)
              socket.write('\r\n')
              sent += chunk.length
            }
          }, 5)
          const finish = (closed: boolean) => {
            clearInterval(pump)
            clearTimeout(timer)
            socket.destroy()
            done({ reply, sent, closed })
          }
          const timer = setTimeout(() => finish(false), 5000)
          socket.on('close', () => finish(true))
          if (wait) {
            socket.pause()
            setTimeout(() => socket.resume(), wait)
          }
        })
        socket.on('data', part => void (reply += part)).on('error', () => {})
      })
      assert.ok(closed, `the server was still reading after ${sent} bytes`)
      assert.match(reply, /^HTTP\/1\.1 413 /, `no answer after ${wait} ms`)
      assert.match(reply, /\r\nconnection: close\r\n/i)
    }
  } finally {
    await served.close()
  }
}

export async function leadGuesses(graph: AccountGraph, clock: { at: number }) {
  const guarded = { kind: 'lead', secret: 'guarded-relay-secret'.repeat(2), auth: 'bearer', mapping: { id: 'id', email: 'mail' } } as const
  const other = { ...guarded, secret: 'other-relay-secret'.repeat(2) } as const
  const served = await leadServer(graph, { leads: { guarded, other }, trustProxy: 1 })
  const lead = (id: string) => JSON.stringify({ id, mail: `${id.toLowerCase()}@example.org` })
  const from = (address: string) => ({ 'x-forwarded-for': address })
  try {
    for (let i = 0; i < 10; i++) assert.equal((await served.post('guarded', lead('G0'), { ...bearer('guess-' + i), ...from('192.0.2.7') })).status, 401)
    const waiting = await served.post('guarded', lead('G0'), { ...bearer('guess-10'), ...from('192.0.2.7') })
    assert.deepEqual([waiting.status, waiting.body, Number(waiting.retry) > 0], [429, { error: 'Too many failed signatures from this address' }, true])
    // The real sender shares that address, as a relay pool or an unconfigured proxy does, and is not held up.
    assert.deepEqual((await served.post('guarded', lead('G1'), { ...bearer(guarded.secret), ...from('192.0.2.7') })).body, newLead)
    assert.equal((await served.post('guarded', lead('G0'), { ...bearer('guess-11'), ...from('192.0.2.7') })).status, 429)
    // Another address, or another source from the same one, is not held up either.
    assert.equal((await served.post('guarded', lead('G0'), { ...bearer('guess-12'), ...from('192.0.2.8') })).status, 401)
    assert.deepEqual((await served.post('guarded', lead('G2'), { ...bearer(guarded.secret), ...from('192.0.2.8') })).body, newLead)
    assert.deepEqual((await served.post('other', lead('G3'), { ...bearer(other.secret), ...from('192.0.2.7') })).body, newLead)
    clock.at += 60_000
    assert.equal((await served.post('guarded', lead('G0'), { ...bearer('guess-13'), ...from('192.0.2.7') })).status, 401)
  } finally {
    await served.close()
  }
}

export async function leadTimes(graph: AccountGraph, clock: { at: number }) {
  const { engine } = await internalsOf(graph)!()
  const timed = { kind: 'lead', secret: 'timed-relay-secret'.repeat(2), auth: 'bearer', mapping: { id: 'id', email: 'mail', at: 'when' } } as const
  const served = await leadServer(graph, { leads: { timed } })
  const send = (id: string, when: unknown) => served.post('timed', JSON.stringify({ id, when, mail: `${id.toLowerCase()}@example.org` }), bearer(timed.secret))
  const seconds = Math.floor(clock.at / 1000) - 600
  const day = 86_400_000
  try {
    // A number below 1e11 is seconds, and one above is milliseconds.
    for (const [id, when, at] of [['T1', seconds, seconds * 1000], ['T2', String(seconds), seconds * 1000], ['T3', `${seconds}.25`, seconds * 1000 + 250], ['T4', seconds * 1000 + 7, seconds * 1000 + 7], ['T5', clock.at + day, clock.at + day]] as const) {
      assert.deepEqual((await send(id, when)).body, newLead, id)
      assert.equal((await engine.graph.outcomeOf(`lead:timed:${id}`))?.at, at, id)
    }
    // Past the day a vendor's clock may run ahead, or before 1970, the time is refused.
    for (const when of [clock.at + day + 1, Math.floor((clock.at + day) / 1000) + 1, new Date(clock.at + 2 * day).toISOString(), 8_000_000_000_000_000, 0, -5, seconds * 1000 + 0.5, '1.2345']) {
      assert.equal((await send('T9', when)).status, 400, String(when))
    }
    assert.equal(await engine.graph.outcomeOf('lead:timed:T9'), undefined)
  } finally {
    await served.close()
  }
}

export async function leadSpellings(graph: AccountGraph) {
  const { engine } = await internalsOf(graph)!()
  const hex = { kind: 'lead', secret: 'hex-spelling-secret'.repeat(2), auth: { header: 'X-Proof', encoding: 'hex' }, mapping: { id: 'id', email: 'mail', phone: 'phone' } } as const
  const b64 = { ...hex, secret: 'b64-spelling-secret'.repeat(2), auth: { header: 'X-Proof', encoding: 'base64' } } as const // gitleaks:allow (a made-up test secret)
  const open = { ...hex, secret: 'bearer-spelling-secret'.repeat(2), auth: 'bearer' } as const
  const served = await leadServer(graph, { leads: { hex, b64, open } })
  const mac = (secret: string, raw: string) => createHmac('sha256', secret).update(raw).digest()
  const body = (id: string) => JSON.stringify({ id, mail: `${id.toLowerCase()}@example.org` })
  try {
    const spelled: [string, string, (raw: string) => Record<string, string>][] = [
      ['hex', 'H1', raw => ({ 'X-Proof': mac(hex.secret, raw).toString('hex').toUpperCase() })],
      ['hex', 'H2', raw => ({ 'X-Proof': 'sha256=' + mac(hex.secret, raw).toString('hex') })],
      ['hex', 'H3', raw => ({ 'X-Proof': 'SHA256=' + mac(hex.secret, raw).toString('hex') })],
      ['b64', 'B1', raw => ({ 'X-Proof': mac(b64.secret, raw).toString('base64') })],
      ['b64', 'B2', raw => ({ 'X-Proof': mac(b64.secret, raw).toString('base64').replace(/=+$/, '') })],
      ['b64', 'B3', raw => ({ 'X-Proof': mac(b64.secret, raw).toString('base64url') })],
      ['b64', 'B4', raw => ({ 'X-Proof': 'sha256=' + mac(b64.secret, raw).toString('base64') })],
      ['open', 'O1', () => ({ authorization: 'bearer ' + open.secret })],
      ['open', 'O2', () => ({ authorization: 'BEARER ' + open.secret })],
    ]
    for (const [name, id, sign] of spelled) {
      const raw = body(id)
      assert.deepEqual((await served.post(name, raw, sign(raw))).body, newLead, id)
    }
    // Each spelling still proves only its own body, under its own secret.
    const raw = body('W1')
    for (const [name, headers] of [
      ['hex', { 'X-Proof': 'sha256=' + mac(hex.secret, body('H1')).toString('hex') }], ['hex', { 'X-Proof': 'sha1=' + mac(hex.secret, raw).toString('hex') }],
      ['hex', { 'X-Proof': mac(hex.secret, raw).toString('base64') }], ['b64', { 'X-Proof': mac(b64.secret, raw).toString('base64url') + 'A' }],
      ['b64', { 'X-Proof': mac(hex.secret, raw).toString('base64url') }], ['open', { authorization: 'Basic ' + open.secret }], ['open', { authorization: open.secret }],
      ['open', { authorization: 'bearer ' + open.secret.toUpperCase() }],
    ] as const) assert.equal((await served.post(name, raw, headers)).status, 401, JSON.stringify(headers))
    // A phone the vendor keeps as digits arrives as a JSON number.
    assert.deepEqual((await served.post('open', JSON.stringify({ id: 'N1', phone: 2025550142 }), bearer(open.secret))).body, newLead)
    const ids = (await engine.store.read(tx => tx.edgesOf(['lead:open:N1']))).map(row => row.identifier)
    assert.ok(ids.includes('phone:' + hashPhone('+12025550142')))
    for (const phone of [2025550142.5, -2025550142, 1e300]) assert.deepEqual((await served.post('open', JSON.stringify({ id: 'N2', phone }), bearer(open.secret))).body, ignored)
  } finally {
    await served.close()
  }
}

export async function leadUpdates(graph: AccountGraph, clock: { at: number }) {
  const { engine } = await internalsOf(graph)!()
  const vendor = { kind: 'lead', secret: 'updating-vendor-secret'.repeat(2), auth: 'bearer', updates: true, mapping: { id: 'id', at: 'when', email: 'mail', phone: 'phone', subject: 'record' } } as const
  const { updates: _, ...plain } = vendor
  const form = { ...plain, secret: 'visitor-form-relay-secret'.repeat(2) } as const
  const served = await leadServer(graph, { leads: { vendor, form } })
  const send = (fields: object) => served.post('vendor', JSON.stringify(fields), bearer(vendor.secret))
  const sendForm = (fields: object) => served.post('form', JSON.stringify(fields), bearer(form.secret))
  const idsOf = async (subject: string) => (await engine.store.read(tx => tx.edgesOf([subject]))).map(row => row.identifier)
  const added = { recorded: ['profile'], duplicate: false }
  try {
    assert.deepEqual((await send({ id: 'K1', phone: '+12025550150' })).body, newLead)
    const first = (await engine.graph.outcomeOf('lead:vendor:K1'))?.at
    clock.at += 1000
    // The vendor posts the same lead again once it knows more: the new details join the same record.
    assert.deepEqual((await send({ id: 'K1', phone: '+12025550150', mail: 'k1@example.org' })).body, added)
    assert.ok((await idsOf('lead:vendor:K1')).includes(email('k1@example.org')))
    assert.equal((await engine.graph.outcomeOf('lead:vendor:K1'))?.at, first)
    for (const again of [{ id: 'K1', phone: '+12025550150', mail: 'k1@example.org', note: marker }, { id: 'K1', phone: '+12025550150' }]) assert.deepEqual((await send(again)).body, duplicate)
    // A vendor time that moves keeps the first one.
    const at = clock.at - 50_000
    assert.deepEqual((await send({ id: 'K2', when: at, mail: 'k2@example.org' })).body, newLead)
    assert.deepEqual((await send({ id: 'K2', when: at + 5, mail: 'k2@example.org' })).body, duplicate)
    assert.deepEqual((await send({ id: 'K2', when: at + 9, mail: 'k2@example.org', phone: '+12025550152' })).body, added)
    assert.equal((await engine.graph.outcomeOf('lead:vendor:K2'))?.at, at)
    // An update cannot move the lead to another record.
    assert.equal((await send({ id: 'K1', phone: '+12025550150', mail: 'k1@example.org', record: 'lead:vendor:other' })).status, 409)
    assert.equal((await send({ id: 'K1', mail: 'moved@example.org', record: 'lead:vendor:other' })).status, 409)
    assert.deepEqual(await idsOf('lead:vendor:other'), [])
    assert.equal((await engine.graph.outcomeOf('lead:vendor:K1'))?.subject, 'lead:vendor:K1')
    // Without updates, a visitor who posts under somebody else's ID adds nothing to that lead.
    assert.deepEqual((await sendForm({ id: 'V1', mail: 'v1@example.org' })).body, newLead)
    for (const other of [{ id: 'V1', mail: 'intruder@example.org' }, { id: 'V1', mail: 'v1@example.org', phone: '+12025550153' }, { id: 'V1', phone: '+12025550153' }]) {
      assert.equal((await sendForm(other)).status, 409, JSON.stringify(other))
    }
    assert.deepEqual(await idsOf('lead:form:V1'), [email('v1@example.org')])
    assert.deepEqual((await sendForm({ id: 'V1', mail: 'v1@example.org', when: clock.at - 5 })).body, duplicate)
  } finally {
    await served.close()
  }
}

export async function leadPayments(graph: AccountGraph, at: number) {
  const { engine } = await internalsOf(graph)!()
  const paid = { kind: 'payment', secret: 'payment-relay-secret'.repeat(2), auth: 'bearer', conversions: ['lead:form', 'case'], maxAmount: 500, mapping: { id: 'id', conversion: 'outcome', amount: 'total', currency: 'unit' } } as const
  for (const [key, subject] of [['lead:form:F1', 'intake:F1'], ['case:9', 'contact:9'], ['own-key', 'contact:10'], ['lead:formal:2', 'intake:F2']] as const) {
    assert.ok((await graph.record({ entries: [{ type: 'conversion', key, at, subject, stage: 'inquiry' }] })).results[0]!.ok)
  }
  const untouched = async () => Promise.all(['own-key', 'lead:formal:2'].map(async key => (await engine.graph.outcomeOf(key))?.value))
  const before = await untouched()
  const capped = { ...paid, secret: 'capped-payment-secret'.repeat(2), conversions: ['lead:form'], maxAmount: 100 } as const
  const served = await leadServer(graph, { leads: { paid, capped } })
  const pay = (id: string, outcome: string, total: unknown, name: 'paid' | 'capped' = 'paid') => served.post(name, JSON.stringify({ id, outcome, total, unit: 'USD' }), bearer((name === 'paid' ? paid : capped).secret))
  const paidOk = { status: 200, body: { recorded: ['payment'], duplicate: false }, retry: null }
  try {
    assert.deepEqual(await pay('P1', 'lead:form:F1', 25.5), paidOk)
    assert.deepEqual(await pay('P2', 'case:9', '500'), paidOk)
    // Over the source's cap, or for a conversion it was not given, nothing is paid.
    for (const [id, outcome, total] of [['P3', 'lead:form:F1', 500.01], ['P4', 'lead:form:F1', 1e10], ['P5', 'own-key', 5], ['P6', 'lead:formal:2', 5], ['P7', 'lead:form', 5], ['P8', 'lead:form:', 5], ['P9', 'cases:9', 5]] as const) {
      assert.equal((await pay(id, outcome, total)).status, 400, id)
    }
    assert.deepEqual([(await engine.graph.outcomeOf('lead:form:F1'))?.value, (await engine.graph.outcomeOf('case:9'))?.value], [25.5, 500])
    assert.deepEqual(await untouched(), before)
    // The cap holds for all of a source's payments to one conversion together, and a retry is not counted again.
    assert.deepEqual(await pay('P10', 'lead:form:F1', 474.5), paidOk)
    assert.equal((await pay('P11', 'lead:form:F1', 0.01)).status, 400)
    assert.deepEqual((await pay('P10', 'lead:form:F1', 474.5)).body, duplicate)
    assert.equal((await engine.graph.outcomeOf('lead:form:F1'))?.value, 500)
    // A payment may come before its conversion, and counts toward the cap all the same.
    const statuses: number[] = []
    for (let i = 0; i < 20; i++) statuses.push((await pay(`C${i}`, 'lead:form:later', 100, 'capped')).status)
    assert.deepEqual(statuses, [200, ...Array(19).fill(400)])
    // Another source's cap is its own.
    assert.deepEqual(await pay('P12', 'lead:form:later', 50), paidOk)
    assert.ok((await graph.record({ entries: [{ type: 'conversion', key: 'lead:form:later', at, subject: 'intake:later', stage: 'inquiry' }] })).results[0]!.ok)
    assert.equal((await engine.graph.outcomeOf('lead:form:later'))?.value, 150)
  } finally {
    await served.close()
  }
}

export async function leadForgotten(graph: AccountGraph, clock: { at: number }) {
  const { engine } = await internalsOf(graph)!()
  const vendor = { kind: 'lead', secret: 'forgetting-vendor-secret'.repeat(2), auth: 'bearer', prefix: 'client', mapping: { id: 'id', subject: 'record', email: 'mail' } } as const
  const office = { ...vendor, secret: 'forgetting-office-secret'.repeat(2), prefix: 'office', trustSubjects: true } as const
  const served = await leadServer(graph, { leads: { vendor, office } })
  const send = (name: 'vendor' | 'office', fields: object) => served.post(name, JSON.stringify(fields), bearer((name === 'vendor' ? vendor : office).secret))
  const forget = async (subject: string) => assert.ok((await graph.forget({ subjects: [subject], key: `forget ${subject}`, at: clock.at, by: 'operator', platforms: 'report' })).ok)
  try {
    assert.deepEqual((await send('vendor', { id: 'L1', record: 'client:five', mail: 'five@example.org' })).body, newLead)
    await forget('client:five')
    // A new vendor ID that names the forgotten subject does not bring it back.
    assert.deepEqual((await send('vendor', { id: 'L2', record: 'client:five', mail: 'five@example.org' })).body, forgotten)
    assert.deepEqual(await engine.store.read(tx => tx.edgesOf(['client:five'])), [])
    assert.equal(await engine.graph.outcomeOf('lead:vendor:L2'), undefined)
    // Nor does a trusted sender, for a subject your own services wrote and then forgot.
    assert.ok((await graph.record({ entries: [{ type: 'profile', key: 'own-gone', at: clock.at, subject: 'contact:gone', facts: { email: 'gone@example.org' } }] })).results[0]!.ok)
    await forget('contact:gone')
    assert.deepEqual((await send('office', { id: 'L3', record: 'contact:gone', mail: 'gone@example.org' })).body, forgotten)
    assert.deepEqual(await engine.store.read(tx => tx.edgesOf(['contact:gone'])), [])
    // Other subjects of the source, and record calls with new keys, go on as before.
    assert.deepEqual((await send('vendor', { id: 'L4', mail: 'four@example.org' })).body, newLead)
    // Pruning receipts, however old, keeps the tombstones.
    assert.ok(await engine.store.write(tx => tx.pruneReceipts(clock.at + 800 * 86_400_000)) > 0)
    assert.deepEqual((await send('office', { id: 'L5', record: 'contact:gone', mail: 'gone@example.org' })).body, forgotten)
    // A profile your own services record brings that exact subject back, and leads may file under it again.
    assert.ok((await graph.record({ entries: [{ type: 'profile', key: 'own-back', at: clock.at, subject: 'contact:gone', facts: { email: 'back@example.org' } }] })).results[0]!.ok)
    assert.deepEqual((await send('office', { id: 'L6', record: 'contact:gone', mail: 'gone@example.org' })).body, newLead)
    assert.deepEqual((await send('vendor', { id: 'L7', record: 'client:five', mail: 'five@example.org' })).body, forgotten)
  } finally {
    await served.close()
  }
}
