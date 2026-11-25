import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRefused } from '../src/contract/fault.ts'
import { recordCall } from '../src/core/calls.ts'
import { hashPhone } from '../src/core/identifiers.ts'
import { createEngine } from '../src/core/engine.ts'
import { createSix } from '../src/core/six.ts'
import { createGraph } from '../src/core/graph.ts'
import { createReceipts, RECEIPT_RETENTION } from '../src/core/receipts.ts'
import type { Graph } from '../src/core/graph.ts'
import type { Store } from '../src/core/store.ts'
import type { Opened } from './suite.ts'

const AT = 1_790_000_000_000

function* orders<T>(list: readonly T[]): Generator<T[]> {
  if (list.length <= 1) yield [...list]
  else for (const [i, each] of list.entries()) for (const rest of orders([...list.slice(0, i), ...list.slice(i + 1)])) yield [each, ...rest]
}

/** Does each, in order, and again what was refused for coming too early, until nothing is. */
async function inOrder(steps: readonly (() => Promise<unknown>)[]) {
  let left = [...steps]
  while (left.length > 0) {
    const early: typeof left = []
    for (const step of left) await step().catch((error) => {
      if (!isRefused(error)) throw error
      if (error.refusal.reason === 'UNKNOWN_REFERENCE') early.push(step)
      else assert.equal(error.refusal.reason, 'PAID')
    })
    if (early.length === left.length) throw new Error('nothing goes on')
    left = early
  }
}

export function saidSuite(name: string, open: () => Promise<Opened>) {
  test(`${name}: profile receipts expire while the newest creation date stands`, async () => {
    const { store, close } = await open()
    try {
      let clock = AT + 3_600_000
      const engine = createEngine(store, { now: () => clock })
      const six = createSix(engine, { receipts: createReceipts(['r'.repeat(40)]) })
      const expire = () => {
        clock += RECEIPT_RETENTION + 1
        return store.write(tx => tx.pruneReceipts(clock - RECEIPT_RETENTION))
      }
      const subject = 'contact:legacy'
      const plain = { type: 'profile', key: 'legacy', at: AT, subject, facts: { email: 'pat@example.org' } } as const
      // A receipt from 64802da, before profiles could carry a creation time.
      await store.write(tx => tx.addReceipt({
        type: 'profile', mac: '7402b4193500c447af5cb96a0d4765f96cb0b46a83faf42c5db266fb1a6e24d0', secretId: 'c2cb0471e211',
        digest: { at: '0VtTnar1oNZ0ISC2QEZfgx', subject: 'llM50BThug05jEl-9mmqdV', facts: 'TmInCtTQkeBuVShG1jWfiX' },
        version: 10001, at: AT, recorded: AT + 3_600_000,
      }, [subject]))
      const old = { ...plain, key: 'first', at: AT - 20, createdAt: 9 }
      const corrected = { ...plain, key: 'correction', createdAt: 8 }
      const { results } = await six.record({ entries: [plain, { ...plain, createdAt: 1 }, old, corrected] })
      assert.ok(results[0]?.ok && results[0].value.duplicate)
      assert.deepEqual(results[1], { type: 'profile', key: 'legacy', ok: false, reason: 'KEY_REUSED', fields: ['createdAt'] })
      assert.ok(results.slice(2).every(r => r.ok && !r.value.duplicate))
      await assert.rejects(engine.unit(async ({ tx }) => {
        await tx.setCreatedAt(subject, 7, AT + 1, 'interrupted')
        throw new Error('stopped before receipt')
      }), /stopped before receipt/)
      assert.equal(await expire(), 3)
      await engine.graph.prune(clock)
      assert.deepEqual(await engine.graph.history(subject), [])
      assert.deepEqual((await engine.graph.subjectDates([subject])).get(subject), { firstSeen: old.at, createdAt: 8 })
      const [retried] = (await six.record({ entries: [old] })).results
      assert.ok(retried?.ok && !retried.value.duplicate && !retried.value.stands)
      assert.deepEqual((await engine.graph.subjectDates([subject])).get(subject), { firstSeen: old.at, createdAt: 8 })
      const replacement = { ...corrected, createdAt: 6 }
      const replay = (await six.record({ entries: [replacement, replacement, corrected, plain] })).results
      assert.deepEqual(replay.slice(0, 2).map(r => r.ok && [r.value.duplicate, r.value.stands]), [[false, false], [true, false]])
      assert.deepEqual(replay[2], { type: 'profile', key: corrected.key, ok: false, reason: 'KEY_REUSED', fields: ['createdAt'] })
      assert.ok(replay[3]?.ok && !replay[3].value.duplicate)
      assert.deepEqual((await engine.graph.subjectDates([subject])).get(subject), { firstSeen: old.at, createdAt: 8 })
      assert.equal(await expire(), 3)
      const identical = (await six.record({ entries: [corrected, corrected] })).results
      assert.deepEqual(identical.map(r => r.ok && [r.value.duplicate, r.value.stands]), [[false, true], [true, true]])
      assert.equal(await expire(), 1)
      const earlier = { ...corrected, at: AT - 1 }
      const revised = (await six.record({ entries: [earlier, earlier, old, plain] })).results
      assert.deepEqual(revised.map(r => r.ok && [r.value.duplicate, r.value.stands]), [[false, false], [true, false], [false, false], [false, true]])
      assert.deepEqual((await engine.graph.subjectDates([subject])).get(subject), { firstSeen: old.at, createdAt: 8 })
      assert.ok((await six.forget({ key: 'erase', at: clock, subjects: [subject], by: 'desk', platforms: 'report' })).ok)
      await expire()
      assert.deepEqual((await six.record({ entries: [old, corrected, plain] })).results.map(r => !r.ok && r.reason), ['FORGOTTEN', 'FORGOTTEN', 'FORGOTTEN'])
      assert.deepEqual(await engine.graph.subjectDates([subject]), new Map())
      assert.ok((await six.record({ entries: [{ ...plain, key: 'new-record', at: AT + 1 }] })).results[0]?.ok)
      assert.deepEqual((await engine.graph.subjectDates([subject])).get(subject), { firstSeen: AT + 1 })
    } finally {
      await close()
    }
  })

  test(`${name}: forgetting after receipt expiry treats a dated profile like any other profile`, async () => {
    const { store, close } = await open()
    try {
      let clock = AT
      const engine = createEngine(store, { now: () => clock })
      const six = createSix(engine, { receipts: createReceipts(['r'.repeat(40)]) })
      const subject = 'contact:date-only'
      const plain = { type: 'profile', key: 'speaker', at: AT, subject, facts: {}, speaker: { email: 'desk@example.org' } } as const
      const dated = { ...plain, key: 'dated', createdAt: AT - 10 }
      assert.ok((await six.record({ entries: [plain, dated] })).results.every(row => row.ok))
      clock += RECEIPT_RETENTION + 1
      assert.equal(await store.write(tx => tx.pruneReceipts(clock - RECEIPT_RETENTION)), 2)
      assert.deepEqual((await engine.graph.subjectDates([subject])).get(subject), { createdAt: dated.createdAt })
      assert.ok((await six.forget({ key: 'erase', at: clock, by: 'desk', subjects: [subject], platforms: 'report' })).ok)
      assert.deepEqual(await engine.graph.subjectDates([subject]), new Map())
      // A receipt already pruned before deletion can no longer identify a retry.
      const replay = (await six.record({ entries: [dated, plain] })).results
      assert.deepEqual(replay.map(row => row.ok && [row.value.duplicate, row.value.stands]), [[false, true], [false, true]])
      assert.deepEqual((await engine.graph.subjectDates([subject])).get(subject), { createdAt: dated.createdAt })
    } finally {
      await close()
    }
  })

  test(`${name}: first seen uses the earliest retained activity on each exact subject`, async () => {
    const { store, close } = await open()
    try {
      const consent = { adUserData: true, adPersonalization: false, recorded: AT }
      const message = { id: 'one', direction: 'inbound' as const, at: 4, to: '+12025550101', flags: [], recorded: AT, visitor: 'visitor:inferred' }
      await store.write(async tx => {
        await tx.addSightings([{ subject: 'sighting', identifier: 'device:one', at: 0, recorded: AT }, { subject: 'staff', identifier: 'review:join-1', at: 0, recorded: AT }])
        await tx.addTouch({ subject: 'arrival', at: 2, source: 'site' })
        await tx.setOutcome({ transactionId: 'one', subject: 'outcome', at: 3, stage: 'sale', currency: 'USD', value: 5 })
        await tx.setCall({ ...message, subject: 'call' })
        await tx.setText({ ...message, at: 5, subject: 'text' })
        await tx.addConsent('legacy', { ...consent, at: 0, source: 'before history' })
        await tx.addConsent('epoch', { ...consent, at: 0, source: 'before history', key: 'banner' })
        await tx.addConsent('consent', { ...consent, at: 6 })
        await tx.setLink({ id: 'sent', subject: 'link', at: 7, expires: AT, openings: 0 })
        await tx.addFlow({ id: 'transfer', from: 'payer', to: 'payee', at: 8, amount: 1, asset: 'USD' })
        await tx.addTouch({ subject: 'sighting', at: 10, source: 'site' })
      })
      const first = { sighting: 0, epoch: 0, arrival: 2, outcome: 3, call: 4, text: 5, consent: 6, link: 7, payer: 8, payee: 8 }
      const expected = new Map(Object.entries(first).map(([id, firstSeen]) => [id, { firstSeen }]))
      assert.deepEqual(await store.read(tx => tx.subjectDates([...expected.keys(), 'staff', 'visitor:inferred', 'legacy', 'missing'])), expected)
    } finally {
      await close()
    }
  })

  test(`${name}: two desks that saw no party cannot both name one, even before the call arrives`, async () => {
    const { store, close } = await open()
    try {
      const receipts = createReceipts(['a'.repeat(32)])
      const engine = createEngine(store, { now: () => AT + 30 })
      const six = createSix(engine, { receipts })
      const call = { type: 'call', key: 'inquiry', at: AT, direction: 'inbound', from: '+12025550101', to: '+12025550102', duration: 60 } as const
      const desks = ['east', 'west'].map((by, i) => ({
        type: 'call_update', call: call.key, key: 'statement-' + by, at: AT + i + 1,
        change: { kind: 'party', role: 'self', subject: 'record:' + by, by, seen: null },
      } as const))
      const results = await Promise.all(desks.map(async entry => (await six.record({ entries: [entry] })).results[0]!))
      assert.equal(results.filter(row => row.ok).length, 1)
      const winner = desks[results.findIndex(row => row.ok)]!
      const lost = results.findIndex(row => !row.ok)
      const refused = desks[lost]!
      assert.deepEqual(results[lost], { type: refused.type, key: refused.key, ok: false, reason: 'STALE', decision: winner.key, by: winner.change.by, at: winner.at })
      assert.equal(await store.read(tx => tx.receiptOf(refused.type, receipts.mac(refused.type, refused.key).all)), undefined)
      assert.deepEqual((await engine.graph.partyHistory(call.key)).map(each => each.key), [winner.key])
      const seen = await six.lookup({ kind: 'party', call: call.key })
      assert.deepEqual(seen, { key: winner.key, at: winner.at, role: 'self', subject: winner.change.subject, by: winner.change.by })
      assert.ok(seen && 'key' in seen)
      const [arrival] = (await six.record({ entries: [call] })).results
      assert.ok(arrival?.ok && arrival.type === 'call' && arrival.value.subject === winner.change.subject)
      const correction = { ...refused, at: AT + 3, change: { ...refused.change, seen: seen.key } }
      const [saved, retry, reread, reused] = (await six.record({ entries: [
        correction, winner, { ...winner, change: { ...winner.change, seen: correction.key } },
        { ...winner, change: { ...winner.change, by: 'another desk' } },
      ] })).results
      assert.ok(saved?.ok && saved.value.stands && !saved.value.duplicate)
      assert.ok(retry?.ok && !retry.value.stands && retry.value.duplicate)
      assert.deepEqual(reread, retry)
      assert.deepEqual(reused, { type: winner.type, key: winner.key, ok: false, reason: 'KEY_REUSED', fields: ['change'] })
      await six.forget({ key: 'erase-former', subjects: [winner.change.subject], by: 'desk', platforms: 'report', at: AT + 20 })
      assert.deepEqual(await six.lookup({ kind: 'party', call: call.key }), {
        key: correction.key, at: correction.at, role: 'self', subject: correction.change.subject, by: correction.change.by,
      })
      for (const entry of [winner, { ...winner, key: 'another-try' }]) {
        assert.deepEqual((await six.record({ entries: [entry] })).results[0], { type: entry.type, key: entry.key, ok: false, reason: 'FORGOTTEN' })
      }
    } finally {
      await close()
    }
  })

  test(`${name}: each party change in a batch checks the standing key, even after an undo`, async () => {
    const { store, close } = await open()
    try {
      const engine = createEngine(store, { now: () => AT + 30 })
      const six = createSix(engine, { receipts: createReceipts(['a'.repeat(32)]) })
      const call = 'inquiry'
      const first = { type: 'call_update', call, key: 'first', at: AT, change: { kind: 'party', role: 'unknown', by: 'desk', seen: null } } as const
      const missing = { ...first, change: { ...first.change, seen: 'missing-statement' } }
      const named = { ...first, key: 'named', at: AT + 1, change: { kind: 'party', role: 'self', subject: 'record:pat', by: 'desk', seen: first.key } } as const
      const undo = { ...first, key: 'undo', at: named.at, change: { ...first.change, seen: named.key } }
      const old = { ...first, key: 'signed-earlier', at: AT - 1, change: { ...first.change, seen: undo.key } }
      const late = { ...named, key: 'late', at: AT + 99 }
      const [arrival] = (await six.record({ entries: [
        { type: 'call', key: call, at: AT, direction: 'inbound', from: '+12025550101', to: '+12025550102', duration: 60 },
      ] })).results
      assert.ok(arrival?.ok)
      assert.equal(await six.lookup({ kind: 'party', call }), null)
      const rows = (await six.record({ entries: [missing, first, named, undo, old, late] })).results
      assert.deepEqual(rows.map(row => row.ok ? row.value.stands : row.reason), ['STALE', true, true, true, false, 'STALE'])
      assert.deepEqual(rows[0], { type: first.type, key: first.key, ok: false, reason: 'STALE', decision: null, by: null, at: null })
      assert.deepEqual(rows[5], { type: late.type, key: late.key, ok: false, reason: 'STALE', decision: undo.key, by: undo.change.by, at: undo.at })
      const before = await engine.graph.version()
      assert.deepEqual((await six.record({ entries: [late] })).results[0], rows[5])
      assert.equal(await engine.graph.version(), before)
      const standing = { key: undo.key, at: undo.at, by: undo.change.by, role: undo.change.role }
      assert.deepEqual(await six.lookup({ kind: 'party', call }), standing)
      assert.equal((await engine.graph.keptCall(call))?.subject, 'call:' + call)
      assert.deepEqual((await engine.graph.partyHistory(call)).map(each => each.key), [old.key, first.key, named.key, undo.key])
    } finally {
      await close()
    }
  })

  test(`${name}: forgetting a former party preserves the other record's call and its older receipts`, async () => {
    const { store, close } = await open()
    try {
      const receipts = createReceipts(['a'.repeat(32)])
      const rotated = createReceipts(['b'.repeat(32), 'a'.repeat(32)])
      const engine = createEngine(store, { now: () => AT + 100 })
      const six = createSix(engine, { receipts: rotated })
      const a = 'record:former'
      const b = 'record:owner'
      const line = 'caller:line'
      const id = 'corrected'
      const reference = { type: 'call' as const, key: id }
      const call = { ...reference, direction: 'inbound', from: '+12025550100', to: '+12025550101', at: AT, duration: 60 } as const
      const report = { type: 'call_update', key: 'answer', at: AT, call: id, change: { kind: 'result', result: { answered: true } } } as const
      const old = { type: 'call_update', key: 'weekend', at: AT, call: id, change: { kind: 'party', role: 'self', subject: a, by: 'desk' } } as const
      // The call and result used to index their receipts under the record staff named at the time.
      await store.write(async tx => {
        await tx.setCall({ id, subject: line, direction: 'inbound', to: call.to, at: AT, duration: 60, recorded: AT, flags: [] })
        await tx.addReceipt(receipts.make(call, AT), [a, line])
        await tx.addReceipt(receipts.make(report, AT, reference), [a])
      })
      assert.ok((await six.record({ entries: [old] })).results[0]?.ok)
      const pending = { ...old, key: 'first-pending', call: 'arrives-after' }
      const correct = { ...old, key: 'z', change: { ...old.change, role: 'representative', subject: b } } as const
      const last = { ...correct, call: pending.call, key: 'last-pending' }
      await engine.graph.outcome({ transactionId: 'call:' + id, subject: a, at: AT, value: 50, currency: 'USD' })
      await engine.graph.revise({ key: 'discount', at: AT + 3, transactionId: 'call:' + id, change: { kind: 'refund', amount: 10 } })
      assert.ok((await six.record({ entries: [last, pending, correct] })).results.every(row => row.ok))
      // The campaign name happens to be the erased statement's key. The new owner's notice still belongs to them.
      const alert = { key: 'unreturned:record:owner:other', text: 'Return the call from the weekend campaign', subject: b, at: AT }
      await store.write(tx => tx.addAlert(alert, false, ['other']))
      await six.forget({ key: 'erase', subjects: [a], at: AT + 100, platforms: 'report', by: 'desk' })
      assert.deepEqual((await store.ops.undelivered()).map(each => each.key), [alert.key])
      assert.equal((await engine.graph.keptCall(id))?.subject, b)
      assert.equal((await engine.graph.outcomeOf('call:' + id))?.value, 40)
      assert.deepEqual((await engine.graph.values('call:' + id)).map(each => each.value), [50, 40])
      assert.deepEqual((await engine.graph.partyHistory(id)).map(each => each.key), [correct.key])
      assert.deepEqual((await engine.graph.partyHistory(pending.call)).map(each => each.key), [last.key])
      for (const entry of [old, pending]) {
        const tombstone = await store.read(tx => tx.receiptOf(entry.type, rotated.mac(entry.type, entry.key).all))
        assert.deepEqual([tombstone?.digest, tombstone?.ref, tombstone?.forgotten], [null, undefined, AT + 100])
      }
      for (const entry of [correct, last, call, report]) {
        const receipt = await store.read(tx => tx.receiptOf(entry.type, rotated.mac(entry.type, entry.key).all))
        assert.ok(receipt?.digest && receipt.forgotten === undefined)
      }
      const [arrival] = (await six.record({ entries: [{ ...call, key: pending.call }] })).results
      assert.ok(arrival?.ok && arrival.type === 'call' && arrival.value.subject === b)
      const [retry] = (await six.record({ entries: [old] })).results
      assert.deepEqual(retry, { type: old.type, key: old.key, ok: false, reason: 'FORGOTTEN' })
      assert.deepEqual((await engine.graph.decisions()).map(d => [d.action, d.about]), [['forget', [a]]])
      assert.deepEqual(await store.read(tx => tx.keysOf([a])), [])
    } finally {
      await close()
    }
  })

  test(`${name}: upgrading erases old statements accepted after their record was forgotten`, async () => {
    const { store, close } = await open()
    try {
      const receipts = createReceipts(['a'.repeat(32)])
      const engine = createEngine(store, { now: () => AT + 30 })
      const six = createSix(engine, { receipts })
      const a = 'record:former'
      const b = 'record:current'
      await engine.graph.forget(a)
      const profile = { type: 'profile', key: 'new-profile', subject: a, facts: { email: 'new@example.org' }, at: AT + 2 } as const
      assert.ok((await six.record({ entries: [profile] })).results[0]?.ok)
      const party = (call: string, subject: string, step: number) => ({ type: 'call_update', key: call + '-' + step, at: AT + step, call,
        change: { kind: 'party', role: 'self', subject, by: 'desk' } } as const)
      const old = [party('retained', a, 1), party('retained', b, 2), party('erased', a, 3), party('pending', a, 5)]
      for (const id of ['retained', 'erased']) {
        const call = { type: 'call', key: id, direction: 'inbound', at: AT, duration: 60, from: '+12025550101', to: '+12025550102' } as const
        assert.ok((await six.record({ entries: [call] })).results[0]?.ok)
      }
      await store.write(async tx => {
        for (const entry of old) {
          const { kind, ...data } = entry.change
          await tx.addSaid({ topic: 'party', about: entry.call, key: entry.key, at: entry.at, data })
          await tx.applyCallParty(entry.call)
          // One receipt had already been pruned when the server was upgraded.
          if (entry.call !== 'pending') await tx.addReceipt(receipts.make(entry, AT, { type: 'call', key: entry.call }), [data.subject])
        }
        await tx.setSetting('repairForgottenParties', 'due')
      })
      const newer = { type: 'call', key: 'after-return', direction: 'inbound', at: AT + 35, duration: 60, from: '+12025550103', to: '+12025550102' } as const
      const valid = party(newer.key, a, 36)
      assert.ok((await six.record({ entries: [newer, valid] })).results.every(row => row.ok))
      const interrupted: Store = { ...store, write: (work, options) => store.write(tx => work(new Proxy(tx, { get(target, field) {
        if (field === 'removeSubject') return async (...args: Parameters<typeof target.removeSubject>) => {
          await target.removeSubject(...args)
          throw new Error('server stopped')
        }
        return Reflect.get(target, field)
      } })), options) }
      await assert.rejects(createSix(createEngine(interrupted), { receipts }).repairForgottenParties(), /server stopped/)
      assert.equal((await engine.graph.keptCall('erased'))?.subject, a)
      assert.equal((await engine.graph.partyHistory('retained')).length, 2)
      assert.equal(await store.read(tx => tx.settingOf('repairForgottenParties')), 'due')
      await six.repairForgottenParties()
      assert.equal((await engine.graph.keptCall(newer.key))?.subject, a)
      assert.deepEqual((await six.record({ entries: [newer, valid] })).results.map(row => row.ok && row.value.duplicate), [true, true])
      assert.equal(await engine.graph.keptCall('erased'), undefined)
      assert.equal((await engine.graph.keptCall('retained'))?.subject, b)
      assert.equal((await engine.graph.outcomeOf('call:retained'))?.subject, b)
      assert.equal(await engine.graph.outcomeOf('call:erased'), undefined)
      assert.deepEqual((await engine.graph.partyHistory('retained')).map(each => 'subject' in each && each.subject), [b])
      assert.deepEqual(await engine.graph.partyHistory('pending'), [])
      const rows = (await six.record({ entries: [...old, profile] })).results
      assert.deepEqual(rows.map(row => row.ok ? row.value.duplicate : row.reason), ['FORGOTTEN', true, 'FORGOTTEN', 'FORGOTTEN', true])
      assert.ok((await engine.graph.history(a)).some(row => row.identifier.startsWith('email:')))
      assert.deepEqual((await engine.graph.decisions()).map(d => [d.action, d.about]), [['forget', [a]]])
      assert.equal((await store.read(tx => tx.receiptOf('call_update', receipts.mac('call_update', old[0]!.key).all)))?.digest, null)
      assert.equal(await store.read(tx => tx.settingOf('repairForgottenParties')), 'done')
      assert.deepEqual(await engine.graph.verify(), [])
    } finally {
      await close()
    }
  })

  test(`${name}: startup checks when each old party arrived relative to a returning profile`, async () => {
    const { store, close } = await open()
    try {
      const receipts = createReceipts(['z'.repeat(32)])
      let clock = AT
      const engine = createEngine(store, { now: () => clock })
      const six = createSix(engine, { receipts })
      const subject = 'record:returning'
      await engine.graph.forget(subject)
      const call = (key: string) => ({ type: 'call', key, at: AT + 1, direction: 'inbound', duration: 60, from: '+12025550103', to: '+12025550102' } as const)
      const party = (key: string, call: string, at: number) => ({ type: 'call_update', key, call, at, change: { kind: 'party', role: 'self', subject, by: 'desk' } } as const)
      const early = [party('before', 'erased', AT + 90), party('mixed-old', 'mixed', AT + 40)]
      const noReceipt = party('pruned-before', 'unproven', AT + 80)
      const established = party('mixed-new', 'mixed', AT + 60)
      const olderWriter = party('legacy-valid', 'proven', AT - 10)
      const ids = ['erased', 'mixed', 'unproven', 'proven']
      clock += 5
      assert.ok((await six.record({ entries: ids.map(call) })).results.every(row => row.ok))
      const legacy = async (entry: ReturnType<typeof party>, receipt = true) => store.write(async tx => {
        const { kind, ...data } = entry.change
        await tx.addSaid({ topic: 'party', about: entry.call, key: entry.key, at: entry.at, data })
        await tx.applyCallParty(entry.call)
        if (receipt) await tx.addReceipt(receipts.make(entry, clock, { type: 'call', key: entry.call }), [subject])
      })
      clock += 5
      for (const entry of early) await legacy(entry)
      await legacy(noReceipt, false)
      clock += 10
      const profile = { type: 'profile', key: 'new-profile', at: AT - 30, subject, facts: { email: 'new@example.org' } } as const
      assert.ok((await six.record({ entries: [profile, established] })).results.every(row => row.ok))
      clock += 10
      await legacy(olderWriter)
      await store.write(tx => tx.setSetting('repairForgottenParties', 'due'))
      await six.repairForgottenParties()
      assert.equal(await engine.graph.keptCall('erased'), undefined)
      assert.equal(await engine.graph.keptCall('unproven'), undefined)
      assert.deepEqual((await engine.graph.partyHistory('mixed')).map(row => row.key), [established.key])
      for (const id of ['mixed', 'proven']) {
        assert.equal((await engine.graph.keptCall(id))?.subject, subject)
        assert.equal((await engine.graph.outcomeOf('call:' + id))?.subject, subject)
      }
      const retries = (await six.record({ entries: [...early, noReceipt, established, olderWriter, call('erased'), call('mixed'), call('proven'), profile] })).results
      assert.deepEqual(retries.map(row => row.ok ? row.value.duplicate : row.reason), ['FORGOTTEN', 'FORGOTTEN', 'FORGOTTEN', true, true, 'FORGOTTEN', true, true, true])
      // Pruning the sightings makes a later legacy assertion unprovable. A statement already checked for this deletion stays checked.
      clock += 10
      for (const id of ['after-prune', 'same-clock']) assert.ok((await six.record({ entries: [call(id)] })).results[0]?.ok)
      await store.write(tx => tx.pruneSightings(clock + 1))
      clock += 10
      const unproved = party('no-sighting', 'after-prune', AT + 5)
      await legacy(unproved)
      await engine.graph.observe({ subject, identifiers: ['email:back@example.org'], at: AT + 1 })
      const tied = party('same-clock-key', 'same-clock', AT + 6)
      await legacy(tied)
      await store.write(tx => tx.setSetting('repairForgottenParties', 'due'))
      await six.repairForgottenParties()
      assert.deepEqual((await six.record({ entries: [unproved, tied, established, olderWriter] })).results.map(row => row.ok ? row.value.duplicate : row.reason), ['FORGOTTEN', 'FORGOTTEN', true, true])
      assert.deepEqual(await engine.graph.verify(), [])
    } finally {
      await close()
    }
  })

  test(`${name}: a recreated receipt cannot vouch for a pre-return statement after pruning`, async () => {
    const { store, close } = await open()
    try {
      let clock = AT
      const receipts = createReceipts(['z'.repeat(32)])
      const engine = createEngine(store, { now: () => clock })
      const six = createSix(engine, { receipts })
      const subject = 'record:back'
      await engine.graph.forget(subject)
      const call = (key: string) => ({ type: 'call', key, at: AT + 1, direction: 'inbound', duration: 60, from: '+12025550103', to: '+12025550102' } as const)
      const party = (id: string) => ({ type: 'call_update', key: id + '-party', call: id, at: AT + 100, change: { kind: 'party', role: 'self', subject, by: 'desk' } } as const)
      const entries = ['replayed', 'original', 'marked', 'young', 'one-year'].map(party)
      const [replayed, original, marked, young, boundary] = entries
      clock += 5
      await six.record({ entries: entries.map(e => call(e.call)) })
      const old = async (entry: ReturnType<typeof party>) => store.write(async tx => {
        const { kind, ...data } = entry.change
        await tx.addSaid({ topic: 'party', about: entry.call, key: entry.key, at: entry.at, data })
        await tx.applyCallParty(entry.call)
        await tx.addReceipt(receipts.make(entry, clock, { type: 'call', key: entry.call }), [subject])
      })
      clock += 5
      await old(replayed!)
      clock += 10
      await engine.graph.observe({ subject, identifiers: ['email:back@example.org'], at: AT })
      clock++
      await old(original!)
      // This prune's requested cutoff includes the old claim, but no post-deletion receipt can be a year old yet.
      clock += 4
      await engine.graph.prune(AT + 15)
      await store.write(tx => tx.pruneReceipts(clock - 365 * 86_400_000))
      clock++
      await old(young!)
      clock = AT + 365 * 86_400_000
      await old(boundary!)
      // The command logs the request and removes receipts in a later transaction. A previously receipted retry can then be stamped as new.
      clock = AT + 365 * 86_400_000 + 9
      await engine.graph.prune(AT + 15)
      clock += 7
      await store.write(tx => tx.pruneReceipts(AT + 15))
      assert.equal(await store.read(tx => tx.receiptOf('call_update', receipts.mac('call_update', replayed!.key).all)), undefined)
      await old(replayed!)
      assert.ok((await six.record({ entries: [marked!] })).results[0]?.ok)
      await store.write(tx => tx.setSetting('repairForgottenParties', 'due'))
      await six.repairForgottenParties()
      assert.equal(await engine.graph.keptCall('replayed'), undefined)
      assert.deepEqual((await six.record({ entries })).results.map(row => row.ok ? row.value.duplicate : row.reason), ['FORGOTTEN', true, true, true, true])
      for (const id of ['original', 'marked', 'young', 'one-year']) assert.equal((await engine.graph.keptCall(id))?.subject, subject)
    } finally {
      await close()
    }
  })

  test(`${name}: removing an unproved winner restores the call and its value to the surviving statement`, async () => {
    const { store, close } = await open()
    try {
      let clock = AT
      const receipts = createReceipts(['z'.repeat(32)])
      const engine = createEngine(store, { now: () => clock })
      const six = createSix(engine, { receipts })
      const a = 'record:returning'
      const b = 'record:current'
      await engine.graph.forget(a)
      const call = (key: string) => ({ type: 'call', key, at: AT + 1, direction: 'inbound', duration: 60, from: '+12025550103', to: '+12025550102' } as const)
      const party = (call: string, key: string, subject: string, at: number) => ({ type: 'call_update', key, call, at, change: { kind: 'party', role: 'self', subject, by: 'desk' } } as const)
      const signed = [party('same', 'true-a', a, AT + 2), party('different', 'true-b', b, AT + 3)]
      const bad = [party('same', 'bad-a', a, AT + 100), party('different', 'bad-b', a, AT + 100)]
      clock += 5
      for (const entry of bad) {
        assert.ok((await six.record({ entries: [call(entry.call)] })).results[0]?.ok)
        await store.write(async tx => {
          const { kind, ...data } = entry.change
          await tx.addSaid({ topic: 'party', about: entry.call, key: entry.key, at: entry.at, data })
          await tx.applyCallParty(entry.call)
          await tx.addReceipt(receipts.make(entry, clock, { type: 'call', key: entry.call }), [a])
        })
      }
      clock += 15
      await engine.graph.observe({ subject: a, identifiers: ['email:a@example.org'], at: AT - 50 })
      for (const entry of signed) {
        assert.ok((await six.record({ entries: [entry] })).results[0]?.ok)
        await engine.graph.restate('call:' + entry.call, 75, 'USD')
      }
      // The older writer accepted more than a batch of claims on one call. Its last arrival is provable and signed earlier than every stale claim.
      const crowded = call('crowded')
      assert.ok((await six.record({ entries: [crowded] })).results[0]?.ok)
      const stale = Array.from({ length: 51 }, (_, i) => party(crowded.key, 'bad-' + i, a, AT + 100 + i))
      const proved = party(crowded.key, 'proven-winner', a, AT + 4)
      clock += 10
      await store.write(async tx => {
        for (const entry of [...stale, proved]) {
          const { kind, ...data } = entry.change
          await tx.addSaid({ topic: 'party', about: entry.call, key: entry.key, at: entry.at, data })
        }
        await tx.addReceipt(receipts.make(proved, clock, { type: 'call', key: crowded.key }), [a])
        await tx.applyCallParty(crowded.key)
        // Each pending call is an independent batch item.
        for (let i = 0; i < 50; i++) await tx.addSaid({ topic: 'party', about: 'no-call-' + i, key: 'pending-' + i, at: clock, data: { role: 'self', subject: a, by: 'desk' } })
      })
      await store.write(tx => tx.setSetting('repairForgottenParties', 'due'))
      await six.repairForgottenParties()
      for (const entry of signed) {
        assert.equal((await engine.graph.keptCall(entry.call))?.subject, entry.change.subject)
        assert.deepEqual((await engine.graph.partyHistory(entry.call)).map(row => row.key), [entry.key])
        const outcome = await engine.graph.outcomeOf('call:' + entry.call)
        assert.deepEqual([outcome?.subject, outcome?.value], [entry.change.subject, 75])
        assert.deepEqual((await store.read(tx => tx.valuesOf('call:' + entry.call, entry.change.subject))).map(row => row.value), [0, 75])
      }
      assert.deepEqual((await six.record({ entries: [...bad, ...signed, call('same'), call('different')] })).results.map(row => row.ok ? row.value.duplicate : row.reason), ['FORGOTTEN', 'FORGOTTEN', true, true, true, true])
      assert.equal((await engine.graph.keptCall(crowded.key))?.subject, a)
      assert.deepEqual((await engine.graph.partyHistory(crowded.key)).map(row => row.key), [proved.key])
      assert.deepEqual((await six.record({ entries: [stale[50]!, proved, crowded] })).results.map(row => row.ok ? row.value.duplicate : row.reason), ['FORGOTTEN', true, true])
      for (let i = 0; i < 50; i++) assert.deepEqual(await engine.graph.partyHistory('no-call-' + i), [])
      assert.deepEqual(await engine.graph.verify(), [])
    } finally {
      await close()
    }
  })

  test(`${name}: a new party statement cannot bring back a forgotten record`, async () => {
    const { store, close } = await open()
    try {
      const receipts = createReceipts(['a'.repeat(32)])
      const engine = createEngine(store, { now: () => AT })
      const six = createSix(engine, { receipts })
      const subject = 'record:erased'
      const request = { key: 'erase-record', by: 'desk', at: AT, subjects: [subject], platforms: 'report' as const }
      assert.ok((await six.forget(request)).ok)
      for (const role of ['self', 'representative', 'excluded'] as const) {
        const entry = { type: 'call_update', key: role, at: AT - 1, call: 'missing', change: { kind: 'party', role, by: 'desk', subject } } as const
        const [row] = (await six.record({ entries: [entry] })).results
        assert.deepEqual(row, { type: entry.type, key: entry.key, ok: false, reason: 'FORGOTTEN' })
        assert.equal(await store.read(tx => tx.receiptOf(entry.type, receipts.mac(entry.type, entry.key).all)), undefined)
      }
      assert.deepEqual(await engine.graph.partyHistory('missing'), [])
      // The existing signed deletion is sufficient even when there was never a profile or a call receipt.
      assert.deepEqual((await engine.graph.decisions()).map(d => [d.action, d.about]), [['forget', [subject]]])
      assert.deepEqual((await engine.graph.audit()).brokenAt, undefined)
    } finally {
      await close()
    }
  })

  test(`${name}: a returned record can be named only on calls after its most recent deletion`, async () => {
    const { store, close } = await open()
    try {
      let clock = AT
      const engine = createEngine(store, { now: () => clock })
      const receipts = createReceipts(['a'.repeat(32)])
      const six = createSix(engine, { receipts })
      const subject = 'contact:returned'
      const profile = (key: string) => ({ type: 'profile', key, at: clock, subject, facts: { email: 'customer@example.org' } } as const)
      const call = (key: string, at: number) => ({ type: 'call', key, at, direction: 'inbound', from: '+12025550102', to: '+12025550103', duration: 60 } as const)
      const statement = (id: string, key: string) => ({ type: 'call_update', key, call: id, at: clock, change: { kind: 'party', role: 'self', subject, by: 'desk' } } as const)
      const erase = (key: string) => six.forget({ key, subjects: [subject], at: clock, by: 'desk', platforms: 'report' })
      assert.ok((await six.record({ entries: [profile('first'), call('old', AT - 2)] })).results.every(row => row.ok))
      assert.ok((await erase('erased')).ok)
      clock += 10
      const signed = statement('new', 'signed')
      assert.ok((await six.record({ entries: [call('new', clock)] })).results[0]?.ok)
      const refuse = async (entry: ReturnType<typeof statement>) => {
        assert.deepEqual((await six.record({ entries: [entry] })).results[0], { type: entry.type, key: entry.key, ok: false, reason: 'FORGOTTEN' })
        assert.equal(await store.read(tx => tx.receiptOf(entry.type, receipts.mac(entry.type, entry.key).all)), undefined)
      }
      await engine.graph.join(subject, 'contact:alias')
      await refuse(signed)
      assert.ok((await six.record({ entries: [profile('returned'), call('boundary', AT)] })).results.every(row => row.ok))
      await refuse(statement('old', 'old-said-now'))
      await refuse(statement('boundary', 'at-deletion'))
      const pending = statement('pending', 'pending-key')
      await refuse(pending)
      assert.ok((await six.record({ entries: [signed, call('pending', clock + 1), pending] })).results.every(row => row.ok))
      assert.equal((await engine.graph.keptCall('new'))?.subject, subject)
      assert.equal((await engine.graph.keptCall('pending'))?.subject, subject)
      clock += 100
      assert.ok((await erase('erased-again')).ok)
      assert.ok((await six.record({ entries: [profile('back-again'), call('between', AT + 50)] })).results.every(row => row.ok))
      await refuse(statement('between', 'after-two-deletions'))
      const retry = (await six.record({ entries: [signed] })).results[0]
      assert.deepEqual(retry, { type: signed.type, key: signed.key, ok: false, reason: 'FORGOTTEN' })
    } finally {
      await close()
    }
  })

  test(`${name}: opening a call reported by an older writer applies its standing party and takes back its guesses`, async () => {
    const { store, close } = await open()
    try {
      const graph = createGraph(store)
      const id = 'older-writer'
      const line = 'caller:old'
      const owner = 'record:a'
      const to = '+12025550104'
      await store.write(async tx => {
        await tx.setCall({ id, subject: line, at: AT, to, visitor: 'visitor:other', tags: { office: 'another' }, flags: ['pool'], recorded: AT, direction: 'inbound' })
        await tx.addSaid({ topic: 'party', about: id, key: 'who', at: AT + 1, data: { role: 'self', subject: owner, by: 'desk' } })
        await tx.addSightings([line, 'visitor:other'].map(subject => ({ subject, identifier: 'dial:' + id, at: AT, recorded: AT, event: 'call' })))
        await tx.addTouch({ subject: line, at: AT, source: 'line', landing: 'tel:' + to })
        await tx.setOutcome({ transactionId: 'call:' + id, subject: line, stage: 'call', value: 20, currency: 'USD', at: AT })
        await tx.addValue('call:' + id, line, { value: 20, currency: 'USD', at: AT })
        await tx.setSetting('repairCallReports', 'due')
      })
      await graph.repairCallReports()
      assert.equal((await graph.keptCall(id))?.subject, owner)
      assert.equal((await graph.keptCall(id))?.tags, undefined)
      await store.read(async tx => {
        assert.deepEqual(await tx.callsOf([line]), [])
        assert.deepEqual(await tx.touchesOf([line], AT, AT), [])
        assert.deepEqual(await tx.edgesOn(['dial:' + id]), [])
        assert.deepEqual([...(await tx.callVisitors([id])).keys()], [])
        assert.equal((await tx.outcomeOf('call:' + id))?.subject, owner)
        assert.equal((await tx.valuesOf('call:' + id, owner))[0]?.value, 20)
        assert.equal(await tx.settingOf('repairCallReports'), 'done')
      })
      assert.deepEqual(await graph.verify(), [])
    } finally {
      await close()
    }
  })

  test(`${name}: repair recognises a repeated blocked call by its completed-call note and preserves a coincident text`, async () => {
    const { store, close } = await open()
    try {
      const graph = createGraph(store)
      const id = 'text-message', subject = 'call:' + id, visitor = 'visitor:same', to = '+12025550106'
      for (const call of [id, 'untouched']) {
        await graph.keepCall({ id: call, subject: 'call:' + call, at: AT, to, direction: 'inbound', flags: ['blocked'], tags: { office: 'one' } })
        await graph.sayParty({ call, key: 'unknown', at: AT + 1, party: { role: 'unknown', by: 'desk' } })
      }
      await store.write(async tx => {
        await tx.setText({ id: 'message', visitor, subject, at: AT, to, direction: 'inbound', flags: [], recorded: AT })
        for (const each of [subject, visitor]) await tx.addSightings([1, 2].map(() => ({ subject: each, identifier: 'dial:' + id, at: AT, recorded: AT + 3, event: 'call' })))
        await tx.addSightings([{ subject, identifier: 'dialed:call-' + id, at: AT, recorded: AT + 3, event: 'call' },
          { subject: 'call:untouched', identifier: 'dialed:call-untouched', at: AT, recorded: AT + 3, event: 'visit' }])
        await tx.setSetting('repairCallReports', 'due')
      })
      await graph.repairCallReports()
      const trace = await store.read(tx => tx.edgesOn(['dial:' + id, 'dialed:call-' + id]))
      assert.deepEqual(trace.map(edge => [edge.identifier, edge.count]), [['dial:' + id, 1], ['dial:' + id, 1]])
      assert.equal((await store.read(tx => tx.textOf('message')))?.visitor, visitor)
      assert.deepEqual((await graph.keptCall('untouched'))?.tags, { office: 'one' })
    } finally {
      await close()
    }
  })

  test(`${name}: a raw report cannot replace a confirmed call`, async () => {
    const { store, close } = await open()
    try {
      const graph = createGraph(store)
      const call = 'late-report'
      await store.write(tx => tx.setCall({ id: call, direction: 'inbound', subject: 'caller:line', at: AT, to: '+12025550101', duration: 4, flags: ['short'], tags: { office: 'one' }, recorded: AT }, 'phone'))
      await graph.sayParty({ call, key: 'a', at: AT + 1, party: { role: 'self', subject: 'record:a', by: 'desk' } })
      const confirmed = await graph.keptCall(call)
      await store.write(tx => tx.setCall({ id: call, direction: 'outbound', subject: 'caller:other', at: AT + 2, to: '+12025550102', duration: 60, flags: ['pool'], visitor: 'visitor:other', tags: { office: 'two' }, recorded: AT + 3 }, 'voip'))
      assert.deepEqual(await graph.keptCall(call), confirmed)
      assert.equal(await store.read(tx => tx.callLine(call)), 'caller:line')
      await graph.sayResult({ call, key: 'missed', at: AT + 4, result: { answered: false } })
      await graph.sayReturn({ call, key: 'returned', at: AT + 5, reachedAt: AT + 5 })
      await graph.sayParty({ call, key: 'b', at: AT + 6, party: { role: 'representative', subject: 'record:b', by: 'desk' } })
      const corrected = (await graph.keptCall(call))!
      assert.deepEqual([corrected.subject, corrected.party?.role, corrected.result?.answered, corrected.result?.returned], ['record:b', 'representative', false, AT + 5])
    } finally {
      await close()
    }
  })

  test(`${name}: a late doubt about a tap cannot mute a confirmed call`, async () => {
    const { store, close } = await open()
    try {
      const graph = createGraph(store)
      const call = 'late-doubt'
      await recordCall(graph, { id: call, at: AT, from: '+12025550103', to: '+12025550104' })
      await graph.sayParty({ call, key: 'heard', at: AT + 1, party: { role: 'self', subject: 'record:a', by: 'desk' } })
      const confirmed = await graph.keptCall(call)
      await graph.doubtCall(call, true)
      assert.deepEqual([...(await store.read(tx => tx.states([`dial:${call}`]))).keys()], [])
      assert.deepEqual(await graph.keptCall(call), confirmed)
    } finally {
      await close()
    }
  })

  test(`${name}: confirming one call moves its history and erases only that call's guesses`, async () => {
    const { store, close } = await open()
    const line = 'caller:line'
    const owner = 'record:a'
    const phone = 'phone:line'
    const to = '+12025550101'
    const calls = ['old', 'new']
    try {
      await store.write(async (tx) => {
        for (const [i, id] of calls.entries()) {
          const at = AT + i
          await tx.setCall({ id, direction: 'inbound', subject: line, at, to, flags: [], recorded: at })
          await tx.addSightings([phone, `dialed:call-${id}`].map(identifier => ({ subject: line, identifier, at, recorded: at, event: 'call' })))
        }
        for (const subject of [line, 'visitor:web']) await tx.addSightings([{ subject, identifier: 'dial:old', at: AT, recorded: AT, event: 'call' }])
        await tx.addTouch({ subject: line, at: AT, source: 'line', landing: `tel:${to}` })
        await tx.setOutcome({ transactionId: 'call:old', subject: line, at: AT, stage: 'call', value: 0, currency: '' })
        await tx.addValue('call:old', line, { value: 0, currency: '', at: AT })
        await tx.outbox.add({ transactionId: 'call:old', target: 'test', subject: line, action: 'sale', at: AT, keys: { phone: 'line' }, due: AT, state: 'pending', attempts: 0 })
        await tx.addSaid({ topic: 'party', about: 'old', key: 'who', at: AT + 2, data: { role: 'representative', subject: owner, by: 'desk' } })
        const affected = await tx.applyCallParty('old')
        assert.ok(affected.includes(line))
        assert.equal((await tx.callOf('old'))?.subject, owner)
        assert.equal(await tx.callLine('old'), line)
        assert.deepEqual((await tx.callsOf([line])).map(call => call.id), ['new'])
        assert.deepEqual((await tx.callsOf([owner])).map(call => call.id), ['old'])
        assert.equal((await tx.outcomeOf('call:old'))?.subject, owner)
        assert.equal((await tx.valuesOf('call:old', owner)).length, 1)
        assert.equal((await tx.valuesOf('call:old', line)).length, 0)
        const [job] = await tx.outbox.get('call:old')
        assert.deepEqual([job?.state, job?.note, job?.keys], ['skipped', 'call_party', {}])
        assert.deepEqual(await tx.edgesOn(['dial:old', 'dialed:call-old']), [])
        assert.deepEqual(await tx.history('visitor:web'), [])
        assert.deepEqual(await tx.edgesOn([phone]), [{ subject: line, identifier: phone, first: AT + 1, last: AT + 1, count: 1 }])
        assert.deepEqual(await tx.touchesOf([line], AT, AT), [])
        const keys = await tx.keysOf([owner])
        assert.ok(keys.some(k => k.type === 'call' && k.key === 'old'))
        await tx.removeSubject(owner)
        assert.equal(await tx.callOf('old'), undefined)
        assert.equal(await tx.outcomeOf('call:old'), undefined)
        assert.deepEqual(await tx.saidOf('party', 'old'), [])
        assert.deepEqual(await tx.outbox.get('call:old'), [])
        assert.ok(await tx.callOf('new'))
      })
    } finally {
      await close()
    }
  })

  test(`${name}: a party named before a call can be forgotten before or after the call`, async () => {
    const { store, close } = await open()
    try {
      await store.write(async (tx) => {
        for (const id of ['arrived', 'pending']) {
          await tx.addSaid({ topic: 'party', about: id, key: id, at: AT, data: { role: 'self', subject: 'record:a', by: 'desk' } })
          assert.deepEqual(await tx.applyCallParty(id), [])
        }
        await tx.setCall({ id: 'arrived', direction: 'outbound', subject: 'caller:line', at: AT, to: '+12025550101', recorded: AT, flags: [] })
        await tx.applyCallParty('arrived', true)
        assert.equal((await tx.callOf('arrived'))?.subject, 'record:a')
        assert.equal(await tx.callLine('arrived'), 'caller:line')
        await tx.addSaid({ topic: 'party', about: 'arrived', key: 'later', at: AT + 1, data: { role: 'unknown', by: 'desk' } })
        await tx.applyCallParty('arrived')
        await tx.pruneCallResults(AT + 1_000)
        await tx.pruneSightings(AT + 1_000)
        await tx.pruneReceipts(AT + 1_000)
        assert.equal((await tx.saidOf('party', 'pending')).length, 1)
        assert.equal(await tx.callLine('arrived'), 'caller:line')
        assert.equal((await tx.callOf('arrived'))?.subject, 'call:arrived')
        assert.deepEqual((await tx.keysOf(['record:a'])).filter(k => k.type === 'call').map(k => k.key).sort(), ['arrived', 'pending'])
        assert.deepEqual((await tx.keysOf(['record:a'])).filter(k => k.type === 'call_update').map(k => k.key).sort(), ['arrived', 'later', 'pending'])
        await tx.removeSubject('record:a')
        assert.deepEqual(await tx.saidOf('party', 'pending'), [])
        assert.equal(await tx.callOf('arrived'), undefined)
      })
    } finally {
      await close()
    }
  })

  test(`${name}: confirmation removes only the channel visit that came from that call`, async () => {
    const { store, close } = await open()
    try {
      const graph = createGraph(store, undefined, { now: () => AT })
      const from = '+12025550100'
      const to = '+12025550101'
      const line = `caller:${hashPhone(from)}`
      const visits = async () => (await graph.journey(line)).entries.flatMap(row => row.kind === 'visit' ? row.touch.source : []).sort()
      await graph.touch({ subject: line, at: AT, landing: `tel:${to}`, source: 'independent' })
      for (const id of ['first', 'second', 'unlisted']) {
        await recordCall(graph, { id, at: AT, from, to }, id === 'unlisted' ? {} : { numbers: { [to]: { source: id } } })
      }
      assert.deepEqual(await visits(), ['first', 'independent', 'second'])
      for (const [call, left] of [['second', ['first', 'independent']], ['unlisted', ['first', 'independent']], ['first', ['independent']]] as const) {
        await graph.sayParty({ call, key: call, at: AT + 1, party: { role: 'self', subject: 'record:a', by: 'desk' } })
        assert.deepEqual(await visits(), left)
      }
    } finally {
      await close()
    }
  })

  test(`${name}: confirmation hides ambiguous channel visits stored before their calls were identified`, async () => {
    const { store, close } = await open()
    try {
      await store.write(async tx => {
        const subject = 'caller:line'
        const to = '+12025550101'
        await tx.setCall({ id: 'old', direction: 'inbound', subject, at: AT, to, flags: [], recorded: AT })
        for (const source of ['one', 'two']) await tx.addTouch({ subject, at: AT, landing: `tel:${to}`, source })
        await tx.addTouch({ subject, at: AT + 1, landing: `tel:${to}`, source: 'later' })
        await tx.addSaid({ topic: 'party', about: 'old', key: 'desk', at: AT + 2, data: { role: 'unknown', by: 'desk' } })
        await tx.applyCallParty('old')
        assert.deepEqual((await tx.touchesOf([subject], AT, AT + 1)).map(touch => touch.source), ['later'])
      })
    } finally {
      await close()
    }
  })

  test(`${name}: confirming a call keeps a simultaneous text tie and other sightings of the line, even after pruning`, async () => {
    const { store, close } = await open()
    try {
      for (const pruned of [false, true]) await store.write(async tx => {
        const text = `message-${Number(pruned)}`
        const id = `text-${text}`
        const line = `caller:line-${text}`
        const visitor = `visitor:v-${text}`
        const phone = `phone:line-${text}`
        const dial = `dial:${id}`
        const to = '+12025550101'
        await tx.setCall({ id, subject: line, visitor, at: AT, to, direction: 'inbound', flags: [], recorded: AT })
        await tx.setText({ id: text, subject: line, visitor, at: AT, to, direction: 'inbound', flags: [], recorded: AT })
        await tx.addSightings([AT, AT, AT + 1].map(at => ({ subject: line, identifier: phone, at, recorded: at, event: 'call' })))
        for (const subject of [line, visitor]) await tx.addSightings([dial, dial].map(identifier => ({ subject, identifier, at: AT, recorded: AT, event: 'call' })))
        if (pruned) await tx.pruneSightings(AT + 1)
        await tx.addSaid({ topic: 'party', about: id, key: id, at: AT + 3, data: { role: 'self', subject: 'record:a', by: 'desk' } })
        await tx.applyCallParty(id)
        const after = await tx.edgesOn([phone, dial])
        assert.deepEqual(after.map(edge => [edge.identifier, edge.count]).sort(), [[dial, 1], [dial, 1], [phone, 2]].sort())
        assert.equal((await tx.textOf(text))?.visitor, visitor)
        assert.deepEqual((await tx.history(visitor)).map(row => row.identifier), pruned ? [] : [dial])
      })
    } finally {
      await close()
    }
  })

  test(`${name}: a call's phone sighting leaves the other line kind intact after pruning`, async () => {
    const { store, close } = await open()
    try {
      for (const kind of ['phone', 'voip']) for (const pruned of [false, true]) await store.write(async tx => {
        const id = `${kind}-${Number(pruned)}`
        const subject = `caller:${id}`
        const own = `${kind}:${id}`
        const other = `${kind === 'phone' ? 'voip' : 'phone'}:${id}`
        await tx.setCall({ id, subject, direction: 'inbound', to: '+12025550101', at: AT, recorded: AT, flags: [] })
        await tx.addSightings([AT - 1, AT + 1].map(at => ({ subject, identifier: other, at, recorded: AT, event: 'profile' })))
        await tx.addSightings([{ subject, identifier: own, at: AT, recorded: AT + 2, event: 'call' }])
        await tx.pruneSightings(AT + (pruned ? 3 : 1))
        await tx.addSaid({ topic: 'party', about: id, key: id, at: AT + 3, data: { by: 'desk', role: 'self', subject: 'record:a' } })
        await tx.applyCallParty(id)
        assert.deepEqual(await tx.edgesOn([own, other]), [{ subject, identifier: other, count: 2, first: AT - 1, last: AT + 1 }])
      })
    } finally {
      await close()
    }
  })

  test(`${name}: confirmation uses the line check of its own call after the sightings are pruned`, async () => {
    const { store, close } = await open()
    try {
      const graph = createGraph(store, undefined, { now: () => AT })
      const from = '+12025550100'
      const hash = hashPhone(from)
      for (const type of ['mobile', 'nonFixedVoip', 'pager']) {
        await recordCall(graph, { id: type, at: AT, from, to: '+12025550101' }, { now: () => AT, lineType: async () => ({ type }) })
      }
      const edges = () => store.read(async tx => (await tx.edgesOn([`phone:${hash}`, `voip:${hash}`])).map(({ identifier, count }) => [identifier, count]).sort())
      const guessed = [[`phone:${hash}`, 1], [`voip:${hash}`, 1]]
      assert.deepEqual(await edges(), guessed)
      await store.write(tx => tx.pruneSightings(AT + 1))
      for (const [i, call] of ['pager', 'nonFixedVoip', 'mobile'].entries()) {
        await graph.sayParty({ call, key: call, at: AT + 2, party: { role: 'self', subject: 'record:a', by: 'desk' } })
        assert.deepEqual(await edges(), guessed.slice(0, 2 - i))
        assert.equal('lineKind' in (await graph.keptCall(call))!, false)
        assert.deepEqual(await graph.verify(), [])
      }
    } finally {
      await close()
    }
  })

  test(`${name}: naming and deleting a call removes its delivery failure events and pending alerts`, async () => {
    const { store, close } = await open()
    try {
      const subject = 'caller:line'
      const id = 'failed-call'
      const owner = 'record:a'
      const error = { type: 'conversion.failed', at: AT, subject, data: { conversion: `call:${id}`, platform: 'test', note: 'rejected' } } as const
      const alert = { key: 'alert:conversions:failed', text: `• call:${id} to test: rejected`, at: AT }
      const delivered = { ...alert, key: 'alert:conversions:delivered' }
      await store.ops.addAlert(delivered)
      await store.ops.alertDelivered(delivered.key, AT)
      await store.write(async tx => {
        await tx.setCall({ id, subject, direction: 'inbound', at: AT, to: '+12025550101', flags: [], recorded: AT })
        await tx.emit([error, { ...error, data: { ...error.data, conversion: 'call:untouched' } }])
        await tx.addAlert(alert)
        await tx.addAlert({ ...alert, key: 'alert:conversions:other', text: '• call:untouched to test: rejected' })
        await tx.addSaid({ topic: 'party', about: id, key: id, at: AT + 1, data: { by: 'desk', role: 'self', subject: owner } })
        await tx.applyCallParty(id)
        assert.deepEqual((await tx.eventsAfter(0, 20)).filter(event => event.type === 'conversion.failed').map(event => event.data.conversion), ['call:untouched'])
      })
      assert.deepEqual((await store.ops.undelivered()).map(({ key }) => key), ['alert:conversions:other'])
      assert.ok(await store.ops.addAlert(delivered))
      await store.ops.alertDelivered(delivered.key, AT)
      await store.write(async tx => {
        await tx.emit([error])
        await tx.addAlert(alert)
        await tx.removeSubject(owner)
        assert.deepEqual((await tx.eventsAfter(0, 20)).filter(event => event.type === 'conversion.failed').map(event => event.data.conversion), ['call:untouched'])
      })
      assert.deepEqual((await store.ops.undelivered()).map(({ key }) => key), ['alert:conversions:other'])
    } finally {
      await close()
    }
  })

  test(`${name}: deleting the physical line tombstones updates made with another receipt secret`, async () => {
    const { store, close } = await open()
    const first = createReceipts(['a'.repeat(32)])
    const rotated = createReceipts(['b'.repeat(32), 'a'.repeat(32)])
    try {
      await store.write(async tx => {
        const line = 'caller:line'
        const call = { type: 'call' as const, key: 'shared', at: AT, direction: 'inbound' as const, from: '+12025550100', to: '+12025550101' }
        const reference = { type: 'call', key: call.key }
        const result = { type: 'call_update' as const, key: 'report', call: call.key, at: AT, change: { kind: 'result' as const, result: { answered: true } } }
        await tx.addReceipt(first.make(call, AT), [line])
        await tx.addReceipt(rotated.make(result, AT + 1, reference), [])
        await tx.setCall({ id: call.key, direction: call.direction, subject: line, at: call.at, to: call.to, flags: [], recorded: AT })
        await tx.addSaid({ topic: 'party', about: call.key, key: 'named', at: AT + 2, data: { role: 'self', subject: 'record:a', by: 'desk' } })
        await tx.applyCallParty(call.key)
        const keys = (await tx.keysOf([line])).map(({ type, key }) => ({ type, ...rotated.mac(type, key) }))
        await tx.forgetReceipts([line], keys, AT + 3)
        await tx.removeSubject(line)
        for (const entry of [call, result]) assert.equal((await tx.receiptOf(entry.type, rotated.mac(entry.type, entry.key).all))?.forgotten, AT + 3)
        assert.deepEqual(await tx.saidOf('party', call.key), [])
        assert.equal(await tx.callOf(call.key), undefined)
      })
    } finally {
      await close()
    }
  })

  const sameInEveryOrder = (what: string, build: (graph: Graph, n: number) => (() => Promise<unknown>)[], read: (graph: Graph, n: number) => Promise<unknown>, expected: unknown) =>
    test(`${name}: ${what}, whatever order it is said in`, async () => {
      const { store, close } = await open()
      const graph = createGraph(store, undefined, { now: () => AT + 1_000_000 })
      try {
        let n = 0
        const steps = build(graph, 0).length
        for (const order of orders([...Array(steps).keys()])) {
          n += 1
          const made = build(graph, n)
          await inOrder(order.map((i) => made[i]!))
          assert.deepEqual(await read(graph, n), expected, `order ${order}`)
        }
      } finally {
        await close()
      }
    })

  const worth = (n: number) => async (graph: Graph) => (await graph.outcomeOf(`t${n}`))!.value
  const revise = (graph: Graph, n: number, key: string, at: number, change: Parameters<Graph['revise']>[0]['change']) => () => graph.revise({ key: `${key}-${n}`, at: AT + at, transactionId: `t${n}`, change })
  const outcome = (graph: Graph, n: number) => () => graph.outcome({ transactionId: `t${n}`, subject: `a${n}`, at: AT, value: 100, currency: 'USD' })

  sameInEveryOrder('a refund, a write-off, a correction and a reversal', (graph, n) => [
    outcome(graph, n),
    revise(graph, n, 'r', 10, { kind: 'refund', amount: 30 }),
    revise(graph, n, 'w', 20, { kind: 'write_off', amount: 15 }),
    revise(graph, n, 'c', 15, { kind: 'correct', value: 90 }),
    revise(graph, n, 'u', 30, { kind: 'reverse', restatement: `w-${n}` }),
  ], (graph, n) => worth(n)(graph), 60)

  sameInEveryOrder('two corrections at one time, told apart by their keys', (graph, n) => [
    outcome(graph, n),
    revise(graph, n, 'a', 10, { kind: 'correct', value: 70 }),
    revise(graph, n, 'b', 10, { kind: 'correct', value: 80 }),
    revise(graph, n, 'c', 9, { kind: 'correct', value: 90 }),
  ], (graph, n) => worth(n)(graph), 80)

  sameInEveryOrder('payments over what was said of the worth', (graph, n) => [
    outcome(graph, n),
    () => graph.pay({ id: `p${n}`, transactionId: `t${n}`, amount: 40 }),
    () => graph.pay({ id: `q${n}`, transactionId: `t${n}`, amount: 10, kind: 'refund' }),
    revise(graph, n, 'c', 10, { kind: 'correct', value: 70 }),
    revise(graph, n, 'r', 11, { kind: 'refund', amount: 5 }),
  ], (graph, n) => worth(n)(graph), 30)

  sameInEveryOrder('how a call went and when they were reached', (graph, n) => [
    () => graph.keepCall({ id: `C${n}`, direction: 'inbound', subject: `caller:${n}`, at: AT, to: '+15551230001', flags: [] }),
    () => graph.sayResult({ call: `C${n}`, key: 'a', at: AT + 10, result: { answered: true, waited: 9 } }),
    () => graph.sayResult({ call: `C${n}`, key: 'b', at: AT + 20, result: { answered: false, voicemail: true } }),
    () => graph.sayReturn({ call: `C${n}`, key: 'x', at: AT + 30, reachedAt: AT + 5 }),
    () => graph.sayReturn({ call: `C${n}`, key: 'y', at: AT + 25 }),
  ], async (graph, n) => {
    const { recorded: _, ...result } = (await graph.keptCall(`C${n}`))!.result!
    return result
  }, { answered: false, voicemail: true, returned: AT + 5 })

  sameInEveryOrder('no lead, and a lead after all', (graph, n) => [
    () => graph.sayLead({ id: `t${n}`, key: 'a', at: AT + 10, kind: 'spam' }),
    () => graph.sayLead({ id: `t${n}`, key: 'b', at: AT + 20 }),
    () => graph.sayLead({ id: `t${n}`, key: 'c', at: AT + 30, kind: 'other' }),
    () => graph.sayLead({ id: `t${n}`, key: 'd', at: AT + 30, kind: 'spam' }),
  ], async (graph, n) => [...(await graph.notLeads([`t${n}`])).values()], [{ kind: 'spam', at: AT + 30 }])

  sameInEveryOrder('the newest read of a cost', (graph, n) => [
    () => graph.spend({ day: '2026-09-01', source: `s${n}`, campaignId: '1', amount: 5 }, { at: AT + 1, key: 'a' }),
    () => graph.spend({ day: '2026-09-01', source: `s${n}`, campaignId: '1', amount: 7 }, { at: AT + 2, key: 'a' }),
    () => graph.spend({ day: '2026-09-01', source: `s${n}`, campaignId: '1', amount: 6 }, { at: AT + 2, key: 'B' }),
  ], async (graph, n) => (await graph.report({ from: '2026-09-01', to: '2026-09-01' })).rows.find((row) => row.source === `s${n}`)!.cost, 7)

  sameInEveryOrder('consent given twice at one time', (graph, n) => [
    () => graph.consent(`a${n}`, { adUserData: true, adPersonalization: true }, { at: AT, key: 'b' }),
    () => graph.consent(`a${n}`, { adUserData: false, adPersonalization: false }, { at: AT, key: 'a' }),
    () => graph.consent(`a${n}`, { adUserData: false, adPersonalization: false }, { at: AT - 1, key: 'z' }),
  ], async (graph, n) => (await graph.consentOf([`a${n}`])).get(`a${n}`), { adUserData: true, adPersonalization: true })

  sameInEveryOrder('what was lost beside payments', (graph, n) => [
    outcome(graph, n),
    () => graph.pay({ id: `lp${n}`, transactionId: `t${n}`, amount: 40 }),
    () => graph.pay({ id: `lq${n}`, transactionId: `t${n}`, amount: 10, kind: 'refund' }),
    revise(graph, n, 'r', 11, { kind: 'refund', amount: 5 }),
  ], async (graph, n) => {
    const { valueChange } = (await graph.report({ from: new Date(AT).toISOString().slice(0, 10), to: new Date(AT).toISOString().slice(0, 10) })).total
    return [await worth(n)(graph), valueChange.refunded / n, valueChange.now / n]
  }, [30, 10, 30])

  test(`${name}: what was lost is in the report as it was said, and goes with the subject`, async () => {
    const { store, close } = await open()
    const graph = createGraph(store, undefined, { now: () => AT + 1_000_000 })
    try {
      await graph.outcome({ transactionId: 't', subject: 'a', at: AT, value: 100, currency: 'USD' })
      await graph.revise({ key: 'r', at: AT + 1, transactionId: 't', change: { kind: 'refund', amount: 30 } })
      await graph.revise({ key: 'w', at: AT + 2, transactionId: 't', change: { kind: 'write_off', amount: 20 } })
      await graph.revise({ key: 'x', at: AT + 2, transactionId: 't', change: { kind: 'write_off', amount: 5 } })
      await graph.revise({ key: 'u', at: AT + 3, transactionId: 't', change: { kind: 'reverse', restatement: 'x' } })
      const day = new Date(AT).toISOString().slice(0, 10)
      const { valueChange } = (await graph.report({ from: day, to: day })).total
      assert.deepEqual([valueChange.first, valueChange.now, valueChange.refunded, valueChange.writtenOff], [100, 50, 30, 20])
      await graph.forget('a', { by: 'dana' })
      await graph.outcome({ transactionId: 't', subject: 'b', at: AT, value: 100, currency: 'USD' })
      assert.equal((await graph.outcomeOf('t'))!.value, 100)
    } finally {
      await close()
    }
  })
}
