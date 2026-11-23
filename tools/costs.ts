/**
 * Sends a CSV of campaign costs to a running server.
 *
 *   GRAPH_URL=http://localhost:8080 GRAPH_TOKEN=… npm run costs -- spend.csv
 *
 * The first line names the columns: day, source, amount, and optionally
 * campaign_id, campaign, currency, clicks, impressions. A day is written
 * YYYY-MM-DD. Sending a file again replaces the rows it names.
 */
import { readFileSync } from 'node:fs'
import { costsFromCsv } from '../src/integrations/costs.ts'

const [file] = process.argv.slice(2)
const { GRAPH_URL, GRAPH_TOKEN } = process.env
if (!file || !GRAPH_URL || !GRAPH_TOKEN) {
  console.error('Usage: GRAPH_URL=… GRAPH_TOKEN=… npm run costs -- spend.csv')
  process.exit(2)
}
const costs = costsFromCsv(readFileSync(file, 'utf8'))
const response = await fetch(new URL('/costs', GRAPH_URL), {
  method: 'POST',
  headers: { authorization: `Bearer ${GRAPH_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify(costs),
})
const answer = await response.text()
if (!response.ok) {
  console.error(`The server answered ${response.status}: ${answer}`)
  process.exit(1)
}
console.log(`Recorded ${costs.length} rows`)
