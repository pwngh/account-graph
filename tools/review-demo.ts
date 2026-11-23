/**
 * Serves the reviewer screen over made-up data, to try it.
 *   npm run review
 * Then open the printed address and enter the reviewer token `demo`.
 */
import { createServer } from 'node:http'
import { createGraph, createMemoryStore } from '../src/index.ts'
import { createHandler } from '../src/server.ts'

const graph = createGraph(createMemoryStore())
const HOUR = 3_600_000
const start = Date.now() - 20 * 24 * HOUR
const login = (subject: string, identifiers: string[], hours = 0) => ({ subject, identifiers, at: start + hours * HOUR, event: 'login' })

await graph.observe([
  // One person with three accounts: same machine, and two of them share a phone.
  login('account:ana', ['hardware:hw-7f', 'phone:p-555', 'ip:203.0.113.20']),
  login('account:ana-alt', ['hardware:hw-7f', 'phone:p-555'], 2),
  login('account:ana-shop', ['hardware:hw-7f', 'email:ana-shop'], 30),
  // A roommate: same address and the same phone model, a different machine.
  login('account:ben', ['hardware:hw-22', 'canvas:c-phone15', 'ip:203.0.113.20']),
  login('account:ana', ['canvas:c-phone15'], 1),
  // Two siblings on one family computer.
  login('account:cy', ['device:family-pc', 'email:cy']),
  login('account:dee', ['device:family-pc', 'email:dee'], 5),
  // A front-desk mailbox shared by four customers.
  ...['eve', 'fay', 'gus', 'hal'].map((name, i) => login(`account:${name}`, ['email:front-desk', `hardware:hw-${name}`], 40 + i)),
])
for (let i = 0; i < 4; i++) await graph.transfer({ from: 'account:ana-alt', to: 'account:ana', amount: 250_000, at: start + (50 + i) * HOUR, asset: 'gold' })
await graph.transfer({ from: 'account:ana', to: 'account:gus', amount: 1_200, at: start + 60 * HOUR, asset: 'gold' })
// A ring: ana pays ana-shop, who pays ben, who pays ana back.
await graph.transfer({ from: 'account:ana', to: 'account:ana-shop', amount: 90_000, at: start + 70 * HOUR, asset: 'gold' })
await graph.transfer({ from: 'account:ana-shop', to: 'account:ben', amount: 85_000, at: start + 71 * HOUR, asset: 'gold' })
await graph.transfer({ from: 'account:ben', to: 'account:ana', amount: 80_000, at: start + 72 * HOUR, asset: 'gold' })
await graph.separate('account:cy', 'account:dee', true, { by: 'dana', reason: 'siblings, one family computer' })

const handler = createHandler(graph, { token: 'service-demo', reviewToken: 'demo', origins: [] })
const port = Number(process.env.PORT ?? 8788)
createServer(handler).listen(port, 'localhost', () => console.log(`reviewer screen: http://localhost:${port}/review  (reviewer token: demo)`))
