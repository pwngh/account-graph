import { createMemoryStore } from '../tools/internals.ts'
import { malformedSuite } from './malformed.suite.ts'
import { opsSuite } from './ops.suite.ts'
import { outboxSuite } from './outbox.suite.ts'
import { suite } from './suite.ts'

const open = async () => ({ store: createMemoryStore(), close: async () => {} })
suite('memory store', open, 3000)
outboxSuite('memory store', open)
opsSuite('memory store', open)
malformedSuite('memory store', open)
