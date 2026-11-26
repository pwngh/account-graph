import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGraph } from '../src/core/graph.ts'
import { createMemoryStore } from '../src/core/memory.ts'
import { createPostgresStore } from '../src/store/postgres.ts'

test('ordinary credit skips identity history that a snapshot replay has to read even before any withdrawal', async () => {
  const who = 'contact:0'
  const log = Array.from({ length: 1000 }, (_, i) => ({ subject: 'contact:' + i, identifier: 'device:' + i, at: 1, recorded_at: 1, event: null, profile_key: 'p' + i, source_fact: null }))
  const sql: string[] = []
  let seen = 0
  const query = async (statement: string) => {
    sql.push(statement)
    if (statement.startsWith('fetch ')) {
      const page = log.slice(seen)
      seen += page.length
      return { rows: page }
    }
    if (statement.startsWith('select * from fixture.edge where subject')) return { rows: [{ subject: who, identifier: 'device:0', first_at: 1, last_at: 1, sightings: 1 }] }
    if (statement.startsWith('select id, fanout, ignored')) return { rows: [{ id: 'device:0', fanout: 1, ignored: false }] }
    if (statement.startsWith('select id, component, cluster')) return { rows: [{ id: who, component: who, cluster: who }] }
    if (statement.includes('from fixture.touch where')) return { rows: [{ subject: who, at: 1, detail: { source: 'search', campaign: 'spring' } }] }
    return { rows: [] }
  }
  const store = createPostgresStore({ query, connect: async () => ({ query, release() {} }) }, 'fixture')
  const first = await createGraph(store).attribute(who, { at: 10 })
  assert.equal(first.credited?.campaign, 'spring')
  assert.equal(sql.length, 9)
  assert.ok(sql.every(statement => !/fixture\.(sighting|fact_withdrawal|withdrawn_edge)/.test(statement)))
  sql.length = 0
  // This fixture's only candidate for credit is its one holder. Load that touch in the same snapshot as the identity replay.
  await store.read(async tx => {
    const copy = await createGraph({ ...store, read: work => work(tx) }).asOf(10)
    const { members } = (await copy.cluster(who))!
    for (const touch of await tx.touchesOf(members, 0, 10)) await copy.touch(touch)
    assert.deepEqual(await copy.attribute(who, { at: 10 }), first)
  })
  assert.equal(seen, 1000)
  assert.equal(sql.length, 10)
})

test('pruned email edges with identical folds and withdrawals can have different ownership histories', async () => {
  async function history(restored: number) {
    const store = createMemoryStore()
    let when = 1
    const graph = createGraph(store, undefined, { now: () => when })
    const subject = 'contact:one'
    const id = 'email:hashed-fact'
    const give = (key: string) => store.write(tx => tx.addSightings([{ subject, identifier: id, at: when, recorded: when, profileKey: key }]))
    const cut = (key: string) => graph.withdrawFact(subject, [id], when, key, { by: 'desk' })
    await give('first')
    when = 2
    await cut('cut')
    when = restored
    await give('restored')
    when = 6
    await cut('cut-again')
    when = 8
    await give('last')
    const held = (await (await graph.asOf(4)).holders([id])).length
    await graph.prune(9)
    const retained = await store.read(async tx => [await tx.edgesOf([subject]), await tx.factHistory(9), await tx.history(subject)])
    return { held, retained }
  }
  const early = await history(3)
  const late = await history(5)
  assert.deepEqual([early.held, late.held], [1, 0])
  assert.deepEqual(early.retained, late.retained)
})
