/**
 * Writes the graph as CSV for an analytics engine, such as DuckDB, where
 * whole-graph questions (communities, rings) are cheaper to ask.
 *   DATABASE_URL=postgres://... node tools/export.ts edges > edges.csv
 *   DATABASE_URL=postgres://... node tools/export.ts flows > flows.csv
 *   DATABASE_URL=postgres://... node tools/export.ts subjects > subjects.csv
 */
import pg from 'pg'

const schema = process.env.GRAPH_SCHEMA ?? 'account_graph'
if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('GRAPH_SCHEMA must be a plain lowercase name')
const queries: Record<string, string> = {
  edges: `select subject, identifier, first_at, last_at, sightings from ${schema}.edge order by subject, identifier`,
  flows: `select source, target, asset, transfers, total, first_at, last_at from ${schema}.flow order by source, target`,
  subjects: `select id, component, cluster from ${schema}.subject order by id`,
}
const query = queries[process.argv[2] ?? '']
if (!query) throw new Error(`Say what to export: ${Object.keys(queries).join(', ')}`)

// A spreadsheet runs a cell that starts like a formula, and subjects and identifiers are written by others. Numbers stay as they are.
const cell = (value: unknown) => {
  const plain = String(value)
  const text = /^\s*[=+\-@\uff1d\uff0b\uff0d\uff20]|^[\t\r\n]/.test(plain) && !/^-?\d+(\.\d+)?$/.test(plain) ? `'${plain}` : plain
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const { rows, fields } = await client.query(query)
  process.stdout.write(fields.map((field) => field.name).join(',') + '\n')
  for (const row of rows) process.stdout.write(fields.map((field) => cell(row[field.name])).join(',') + '\n')
} finally {
  await client.end()
}
