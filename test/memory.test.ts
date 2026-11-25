import { createMemoryStore } from '../tools/internals.ts'
import { malformedSuite } from './malformed.suite.ts'
import { opsSuite } from './ops.suite.ts'
import { outboxSuite } from './outbox.suite.ts'
import { eventsSuite } from './events.suite.ts'
import { unjoinSuite } from './unjoin.suite.ts'
import { saidSuite } from './said.suite.ts'
import { suite } from './suite.ts'
import { unitSuite } from './unit.suite.ts'
import { readHistorySuite } from './read-history.suite.ts'

const open = async () => ({ store: createMemoryStore(), close: async () => {} })
suite('memory store', open, 3000)
readHistorySuite('memory store', open, false)
outboxSuite('memory store', open)
opsSuite('memory store', open)
malformedSuite('memory store', open)
saidSuite('memory store', open)
unjoinSuite('memory store', open)
eventsSuite('memory store', open)
unitSuite('memory store', async () => {
  const store = createMemoryStore()
  return { store, dump: async () => store.snapshot(), close: async () => {} }
})
