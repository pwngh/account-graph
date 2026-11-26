import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { command } from '../src/bin.ts'
import { checkSheet, readChecks, sampleJoins, scoreChecks } from '../src/core/join-check.ts'
import { createGraph, createMemoryStore } from '../tools/internals.ts'

const T0 = 1_700_000_000_000

/** Twelve clusters of three accounts, each three sharing one email, and two accounts a reviewer joined by hand. */
async function graphOfPairs() {
  const store = createMemoryStore()
  const graph = createGraph(store)
  for (let n = 0; n < 12; n++) await graph.observe([0, 1, 2].map((i) => ({ subject: `account:${n}-${i}`, identifiers: [`email:shared-${n}`], at: T0 })))
  await graph.observe([{ subject: 'account:staff-a', identifiers: ['email:a-only'], at: T0 }, { subject: 'account:staff-b', identifiers: ['email:b-only'], at: T0 }])
  await graph.join('account:staff-a', 'account:staff-b', { by: 'dana', reason: 'same client, two intakes' })
  return { store, graph }
}

test('a sample of joins is the same for the same seed, and holds only pairs the graph joined on its own', async () => {
  const { store, graph } = await graphOfPairs()
  const all = await sampleJoins(graph, store, { size: 1000, seed: 'all' })
  // Three accounts sharing one email are three pairs, in each of twelve clusters. The pair a reviewer joined is left out.
  assert.equal(all.length, 36)
  assert.ok(all.every(({ a, b }) => a < b && a.split('-')[0] === b.split('-')[0] && !a.includes('staff')))
  assert.ok(all.every(({ reasons }) => reasons.length > 0 && reasons.every((reason) => reason.startsWith('email:shared-'))))

  const first = await sampleJoins(graph, store, { size: 10, seed: '2026-11' })
  assert.equal(first.length, 10)
  assert.deepEqual(await sampleJoins(graph, store, { size: 10, seed: '2026-11' }), first)
  assert.notDeepEqual(await sampleJoins(graph, store, { size: 10, seed: '2026-12' }), first)

  // A pair a reviewer has since separated is no longer a join to check.
  const { a, b } = first[0]!
  await graph.separate(a, b, true, { by: 'dana' })
  assert.ok(!(await sampleJoins(graph, store, { size: 1000, seed: 'all' })).some((pair) => pair.a === a && pair.b === b))
})

test('the sheet reads back, and the score has a 95% interval', async () => {
  const { store, graph } = await graphOfPairs()
  const sheet = checkSheet(await sampleJoins(graph, store, { size: 4, seed: 'sheet' }))
  const [header, ...lines] = sheet.trimEnd().split('\n')
  assert.equal(header, 'a,b,score,reasons,same')
  assert.equal(lines.length, 4)
  const filled = [header, ...lines.map((line, i) => line + ['yes', 'No', '', ' y '][i])].join('\n')
  assert.deepEqual(readChecks(filled), [true, false, undefined, true])
  assert.throws(() => readChecks(`${header}\n${lines[0]}maybe`), /Line 2 says "maybe"/)
  assert.throws(() => readChecks('a,b\nx,y'), /no "same" column/)

  // 285 of 300: the share is 0.95, and the Wilson interval at 95% is 0.919 to 0.969.
  const score = scoreChecks([...Array(285).fill(true), ...Array(15).fill(false), undefined])
  assert.deepEqual({ ...score, low: Number(score.low!.toFixed(3)), high: Number(score.high!.toFixed(3)) }, { checked: 300, same: 285, different: 15, unanswered: 1, share: 0.95, low: 0.919, high: 0.969 })
  assert.deepEqual(scoreChecks([undefined]), { checked: 0, same: 0, different: 0, unanswered: 1, share: null, low: null, high: null })
})

test('score-joins reads a checked sheet without a database', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'ag-joins-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const file = join(folder, 'checked.csv')
  await writeFile(file, 'a,b,score,reasons,same\nx,y,0.9,"email:1 phone:2",yes\nx,z,0.8,email:1,no\n')
  const said: string[] = []
  await command({}, ['score-joins', file], (line) => said.push(line))
  assert.deepEqual(JSON.parse(said.join('\n')), { checked: 2, same: 1, different: 1, unanswered: 0, share: 0.5, low: 0.095, high: 0.905 })
  await assert.rejects(command({}, ['score-joins'], () => {}), /Usage: account-graph score-joins FILE/)
})
