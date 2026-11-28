import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { configFrom } from '../src/bin.ts'
import { SETTINGS, settingProblems } from '../src/settings.ts'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const base = { DATABASE_URL: 'postgres://127.0.0.1/unused', GRAPH_TOKEN: 'private', RECEIPT_SECRETS: 's'.repeat(32), IDENTIFIER_SECRET: 'i'.repeat(32) }

test('the table of settings is what the server reads, what the guide lists and what Compose passes', () => {
  const bin = read('src/bin.ts')
  const reading = bin.slice(bin.indexOf('export function readEnvironment'), bin.indexOf('export function configFrom'))
  const used = new Set([...reading.matchAll(/env\.([A-Z][A-Z0-9_]+)/g), ...reading.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)].map((match) => match[1]!).filter((name) => name !== 'UTC'))
  assert.deepEqual([...used].filter((name) => !Object.hasOwn(SETTINGS, name)), [], 'read and not in the table')
  assert.deepEqual(Object.keys(SETTINGS).filter((name) => !used.has(name)), [], 'in the table and not read')
  const guide = read('docs/operations.md')
  const listed = new Set([...guide.matchAll(/^\| ((?:`[A-Z][A-Z0-9_]+`(?:, )?)+) \|/gm)].flatMap((row) => [...row[1]!.matchAll(/`([A-Z0-9_]+)`/g)].map((match) => match[1]!)))
  assert.deepEqual(Object.keys(SETTINGS).filter((name) => !listed.has(name)), [], 'not in the guide')
  const compose = read('compose.yaml')
  const graph = compose.slice(compose.indexOf('\n  graph:'), compose.indexOf('\n  review:'))
  const passed = [...graph.matchAll(/^ {6}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]!)
  assert.deepEqual(passed.filter((name) => !Object.hasOwn(SETTINGS, name)), [], 'passed by Compose and not read')
})

test('a setting written another way, or a flag that is not true or false, stops the start', () => {
  for (const [env, said] of [
    [{ FORGET_ADS: 'TRUE' }, 'FORGET_ADS must be true or false'],
    [{ FORGET_ADD: 'true' }, 'FORGET_ADD is not a setting. Did you mean FORGET_ADS?'],
    [{ forget_ads: 'true' }, 'forget_ads is not a setting. Did you mean FORGET_ADS?'],
    [{ RECIEPT_SECRETS: 'x' }, 'RECIEPT_SECRETS is not a setting. Did you mean RECEIPT_SECRETS?'],
    [{ CALL_TIP_SECONDS: '600' }, 'CALL_TIP_SECONDS is not a setting. Did you mean CALL_TAP_SECONDS?'],
    [{ GOOGLE_ADS_CONVERSIONS: '0' }, 'GOOGLE_ADS_CONVERSIONS must be true or false'],
    [{ CHANGE_WEBHOOK: 'https://example.org' }, 'CHANGE_WEBHOOK is now WEBHOOK_URL'],
  ] as const) {
    assert.deepEqual(settingProblems(env), [said])
    assert.throws(() => configFrom({ ...base, ...env }), (error: Error) => error.message.includes(said))
  }
  // What a machine or a container sets for itself is left alone.
  const own = { HOME: '/home/x', PATH: '/bin', HOSTNAME: 'box', NODE_VERSION: '22.0.0', NODE_ENV: 'production', GOOGLE_APPLICATION_CREDENTIALS: '/k.json', TERM: 'xterm', YARN_VERSION: '1',
    MAXMIND_PORT: 'tcp://10.0.0.9:80', MAXMIND_SERVICE_HOST: '10.0.0.9', DATABASE_SSL: 'false', PGHOST: 'db' }
  assert.deepEqual(settingProblems(own), [])
  // Windows reads a name in any case, so there that is the setting itself.
  assert.deepEqual(settingProblems({ database_url: 'postgres://db/graph' }, 'win32'), [])
  assert.doesNotThrow(() => configFrom({ ...base, ...own, FORGET_ADS: 'false', MICROSOFT_SANDBOX: '' }))
})
