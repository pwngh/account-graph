/**
 * Sends a CSV of campaign costs to a running server.
 *
 *   GRAPH_URL=http://localhost:8080 GRAPH_TOKEN=… npm run costs -- spend.csv
 *
 * The first line names the columns: day, source, amount, and optionally
 * campaign_id, campaign, currency, clicks, impressions. A day is written
 * YYYY-MM-DD. Sending a file again replaces the rows it names.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { accountGraph } from '../src/index.ts'
import { costsFromCsv } from '../src/providers/costs.ts'

const [file] = process.argv.slice(2)
const { GRAPH_URL, GRAPH_TOKEN } = process.env
if (!file || !GRAPH_URL || !GRAPH_TOKEN) {
  console.error('Usage: GRAPH_URL=… GRAPH_TOKEN=… npm run costs -- spend.csv')
  process.exit(2)
}
const costs = costsFromCsv(readFileSync(file, 'utf8'))
const graph = accountGraph({ url: GRAPH_URL, token: GRAPH_TOKEN })
// The same file has the same key, so it is recorded once. One that changed has another, and the newest read stands.
const at = Math.floor(statSync(file).mtimeMs)
const key = `file ${createHash('sha256').update(JSON.stringify([at, costs])).digest('hex').slice(0, 32)}`
const { results: [result] } = await graph.record({ entries: [{ type: 'cost', key, at, rows: costs.map((row) => ({ ...row, currency: row.currency || 'USD' })) }] })
if (!result!.ok) {
  console.error(`The server refused it: ${result!.reason}`)
  process.exit(1)
}
console.log(`Recorded ${costs.length} rows${result!.value.duplicate ? ', as before' : ''}`)
await graph.close()
