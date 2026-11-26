import { createGraph, createMemoryStore } from '../../tools/internals.ts'
import type { Graph, Policy, Store } from '../../tools/internals.ts'

/** The generator makes the same ordered decisions in memory. Install what it wrote in one commit so nobody sees half a sample. */
export async function loadFirmHistory(engine: { store: Store; policy: Policy; now: () => number }, generate: (graph: Graph) => Promise<void>, progress: (line: string) => void | Promise<void>) {
  const memory = createMemoryStore()
  await generate(createGraph(memory, engine.policy, { now: engine.now }))
  await progress('Saving sample history')
  const rows = memory.snapshot()
  const feeds = await memory.ops.feeds()
  await engine.store.write(async tx => {
    if (!await tx.empty()) throw new Error('The sample history needs an empty graph')
    await tx.setBuiltWith(rows.built!)
    await tx.addSightings([...rows.sightings.values()].flat())
    for (const id of rows.ignored) await tx.setIgnored(id, true)
    await tx.setLabels(rows.labels)
    await tx.addCosts([...rows.costs.values()])
    await tx.insertActivity({
      touches: [...rows.touches.values()].flat(), outcomes: [...rows.outcomes.values()], decisions: rows.decisions,
      calls: [...rows.calls.values()].map(call => ({ call, lineKind: rows.lineKinds.get(call.id) })), results: [...rows.results],
      values: [...rows.values].flatMap(([subject, own]) => [...own].flatMap(([transactionId, values]) => values.map(value => ({ transactionId, subject, value })))),
    })
    for (const notes of rows.said.values()) for (const note of notes) await tx.addSaid(note)
    for (const [feed, note] of feeds) if (note.last !== undefined) await tx.fed(feed, note.last)
    await tx.emit(rows.events)
  }, { whole: true })
}
