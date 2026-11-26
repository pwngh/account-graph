import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'

const source = readFileSync(new URL('../examples/gtm/account-graph.tpl', import.meta.url), 'utf8')
const parts = source.split(/^___([A-Z_]+)___\r?$/m)
const sections = new Map<string, string>()
for (let i = 1; i < parts.length; i += 2) {
  const name = parts[i]!
  assert.ok(!sections.has(name), 'repeated section ' + name)
  sections.set(name, parts[i + 1]!.trim())
}
const script = new Script('(function (require, data) {\n' + sections.get('SANDBOXED_JS_FOR_WEB_TEMPLATE') + '\n})', { filename: 'account-graph.tpl' })
const graph = 'https://graph.example.org'
const setter = 'accountGraph.setStorageGranted'
const consentTypes = ['ad_storage', 'analytics_storage']

test('the import describes a web tag with fields for each browser setting', () => {
  for (const name of ['INFO', 'TEMPLATE_PARAMETERS', 'SANDBOXED_JS_FOR_WEB_TEMPLATE', 'WEB_PERMISSIONS', 'TESTS']) assert.ok(sections.get(name), name)
  const info = JSON.parse(sections.get('INFO')!)
  assert.equal(info.type, 'TAG')
  assert.deepEqual(info.containerContexts, ['WEB'])
  const parameters = JSON.parse(sections.get('TEMPLATE_PARAMETERS')!) as { name: string, type: string, selectItems?: { value: string }[] }[]
  assert.equal(parameters.length, 7)
  assert.deepEqual(Object.fromEntries(parameters.map(p => [p.name, p.type])), { graphOrigin: 'TEXT', forms: 'SELECT', allowPages: 'TEXT', refusePages: 'TEXT', requireConsent: 'CHECKBOX', events: 'TEXT', text: 'CHECKBOX' })
  assert.deepEqual(parameters.find(p => p.name === 'forms')!.selectItems!.map(item => item.value).sort(), ['all', 'marked'])
})

type Grant = { type: string, template?: string, boolean?: boolean, listItem?: Grant[], mapKey?: Grant[], mapValue?: Grant[] }

function permissionValue(value: Grant): unknown {
  if (value.type === 'TEMPLATE') return value.template
  if (value.type === 'BOOLEAN') return value.boolean
  if (value.type === 'LIST') return value.listItem!.map(permissionValue)
  assert.equal(value.type, 'MAP')
  assert.equal(value.mapKey!.length, value.mapValue!.length)
  const keys = value.mapKey!.map(key => permissionValue(key))
  assert.equal(new Set(keys).size, keys.length)
  return Object.fromEntries(keys.map((key, index) => [key, permissionValue(value.mapValue![index]!)]))
}

test('permissions cover one script, one callable method and two read-only consent types', () => {
  const permissions = JSON.parse(sections.get('WEB_PERMISSIONS')!) as { instance: { key: { publicId: string }, param: { key: string, value: Grant }[] } }[]
  assert.equal(permissions.length, 3)
  const grants = Object.fromEntries(permissions.map(({ instance }) => {
    assert.equal(instance.param.length, 1)
    const { key, value } = instance.param[0]!
    return [instance.key.publicId, { [key]: permissionValue(value) }]
  }))
  assert.deepEqual(grants, {
    inject_script: { urls: [graph + '/collect.js?gtm=1&*'] },
    access_globals: { keys: [{ key: setter, read: false, write: false, execute: true }] },
    access_consent: { consentTypes: consentTypes.map(consentType => ({ consentType, read: true, write: false })) },
  })
})

const urlApis = {
  encodeUriComponent: (value: string) => {
    try { return encodeURIComponent(value) } catch { return undefined }
  },
  parseUrl: (address: string) => {
    try {
      const url = new URL(address, 'https://www.example.org/')
      return { href: url.href, origin: url.origin, protocol: url.protocol, host: url.host, hostname: url.hostname, port: url.port, username: url.username, password: url.password, pathname: url.pathname, search: url.search, hash: url.hash }
    } catch { return undefined }
  },
}

test('the scenarios imported into the template editor run against its sandboxed code', () => {
  // The export uses YAML literal blocks for the JavaScript in each scenario.
  const [header, ...blocks] = sections.get('TESTS')!.split('\n- name: ')
  assert.equal(header, 'scenarios:')
  assert.ok(blocks.length >= 2)
  for (const block of blocks) {
    const match = block.match(/^([^\n]+)\n  code: \|-?\n((?:    [^\n]*(?:\n|$))+)$/)
    assert.ok(match, 'expected a named scenario with an indented code block')
    const calls = new Map<string, unknown[][]>()
    const mocks = new Map<string, (...args: unknown[]) => unknown>(Object.entries(urlApis) as [string, (...args: unknown[]) => unknown][])
    const mock = (name: string, implementation: (...args: unknown[]) => unknown) => mocks.set(name, implementation)
    const api = (name: string) => (...args: unknown[]) => {
      if (!calls.has(name)) calls.set(name, [])
      calls.get(name)!.push(args)
      const implementation = mocks.get(name)
      if (implementation) return implementation(...args)
      assert.ok(['gtmOnFailure', 'gtmOnSuccess'].includes(name), 'unmocked API ' + name)
    }
    const runCode = (fields: object) => script.runInNewContext()(api, { ...fields, gtmOnSuccess: api('gtmOnSuccess'), gtmOnFailure: api('gtmOnFailure') })
    const assertApi = (name: string) => ({
      wasCalled: () => assert.ok(calls.has(name), name),
      wasNotCalled: () => assert.ok(!calls.has(name), name),
      wasCalledWith: (...expected: unknown[]) => assert.ok(calls.get(name)?.some(args => args.length === expected.length && args.every((value, i) => value === expected[i])), name),
    })
    new Script(match[2]!.replace(/^    /gm, ''), { filename: match[1]! }).runInNewContext({ mock, runCode, assertApi })
  }
})

type StubOptions = { denied?: string[], origin?: string, denyPermission?: string, missingSetter?: boolean }
type Injection = { url: string, loaded: () => void, failed: () => void, token: string }

function sandbox(fields: Record<string, unknown> = {}, options: StubOptions = {}) {
  const origin = options.origin ?? graph
  const allowed = new Map(consentTypes.map(type => [type, !options.denied?.includes(type)]))
  const listeners = new Map<string, (type: string, granted: boolean) => void>()
  const injections: Injection[] = []
  const outcomes: string[] = []
  const storage: boolean[] = []
  const permission = (name: string, action: string, key?: string) => {
    if (name === options.denyPermission) return false
    if (name === 'inject_script') return action.startsWith(origin + '/collect.js?gtm=1&')
    if (name === 'access_globals') return action === 'execute' && key === setter
    if (name === 'access_consent') return action === 'read' && allowed.has(key!)
    return assert.fail('unexpected permission ' + name)
  }
  const apis: Record<string, unknown> = {
    queryPermission: permission,
    ...urlApis,
    isConsentGranted: (type: string) => {
      assert.ok(permission('access_consent', 'read', type))
      return allowed.get(type)
    },
    addConsentListener: (type: string, listener: (type: string, granted: boolean) => void) => {
      assert.ok(permission('access_consent', 'read', type))
      listeners.set(type, listener)
    },
    callInWindow: (key: string, granted: boolean) => {
      assert.ok(permission('access_globals', 'execute', key))
      assert.equal(typeof granted, 'boolean')
      if (options.missingSetter) return undefined
      storage.push(granted)
      return true
    },
    injectScript: (url: string, loaded: () => void, failed: () => void, token: string) => {
      assert.ok(permission('inject_script', url))
      injections.push({ url, loaded, failed, token })
    },
  }
  const requireApi = (name: string) => {
    assert.ok(Object.hasOwn(apis, name), 'unexpected GTM API ' + name)
    return apis[name]
  }
  script.runInNewContext()(requireApi, { graphOrigin: origin, ...fields, gtmOnSuccess: () => outcomes.push('success'), gtmOnFailure: () => outcomes.push('failure') })
  const update = (changes: [string, boolean][]) => {
    for (const [type, granted] of changes) allowed.set(type, granted)
    for (const [type, granted] of changes) listeners.get(type)?.(type, granted)
  }
  const change = (type: string, granted: boolean) => update([[type, granted]])
  return { injections, listeners, storage, outcomes, change, update }
}

test('the tag loads its collector from the permitted origin and encodes only the selected options', () => {
  const origin = 'https://visits.example.org:8443'
  const fields = { graphOrigin: origin + '/', forms: 'all', allowPages: '/public, /help/*', refusePages: '/help/staff, /a&b', requireConsent: true, events: 'phone_click, text_click, inquiry', text: true }
  const tag = sandbox(fields, { origin })
  assert.equal(tag.injections.length, 1)
  const injection = tag.injections[0]!
  const url = new URL(injection.url)
  assert.equal(url.origin + url.pathname, origin + '/collect.js')
  assert.equal(url.hash, '')
  assert.deepEqual(Object.fromEntries(url.searchParams), { gtm: '1', forms: 'all', allowPages: '/public,/help/*', refusePages: '/help/staff,/a&b', consent: 'required', events: 'phone_click,text_click,inquiry', text: '1' })
  assert.equal(injection.token, 'account-graph.gtm')
  assert.equal(sandbox(fields, { origin }).injections[0]!.token, injection.token)
  assert.deepEqual(tag.outcomes, [])
  injection.loaded()
  assert.deepEqual(tag.outcomes, ['success'])
  assert.deepEqual(tag.storage, [true])

  const defaults = sandbox({ forms: 'marked', allowPages: '', refusePages: '', requireConsent: false, events: '', text: false }).injections[0]!
  assert.deepEqual(Object.fromEntries(new URL(defaults.url).searchParams), { gtm: '1', events: '' })
  assert.equal(defaults.token, injection.token)
})

test('either denied storage type skips the script and finishes the firing', () => {
  for (const denied of [['ad_storage'], ['analytics_storage'], consentTypes]) {
    const tag = sandbox({}, { denied })
    assert.deepEqual(tag.injections, [])
    assert.deepEqual(tag.outcomes, ['success'])
    assert.equal(tag.listeners.size, 0)
    assert.deepEqual(tag.storage, [])
  }
})

test('consent changes during the download and after load gate the same collector', () => {
  const tag = sandbox()
  assert.deepEqual([...tag.listeners.keys()].sort(), consentTypes)
  tag.change('ad_storage', false)
  assert.equal(tag.storage.length, 0)
  tag.injections[0]!.loaded()
  assert.deepEqual(tag.storage, [false])
  tag.change('analytics_storage', false)
  tag.change('ad_storage', true)
  assert.equal(tag.storage.at(-1), false)
  tag.change('analytics_storage', true)
  assert.equal(tag.storage.at(-1), true)
  tag.change('ad_storage', false)
  const before = tag.storage.length
  tag.update([['ad_storage', true], ['analytics_storage', false]])
  assert.ok(!tag.storage.slice(before).includes(true), 'swapping the two grants must never start a visit')
  assert.equal(tag.storage.at(-1), false)
  assert.deepEqual(tag.outcomes, ['success'])
  assert.equal(tag.injections.length, 1)
})

test('bad graph addresses and a denied script permission fail before injection', () => {
  const addresses = ['', graph + '/collect.js', graph + '?x=1', graph + '#x', 'http://graph.example.org', '//graph.example.org', 'https://graph.example.org@other.example.org', 'https://user@graph.example.org', 'https://graph.example.org.other.example.org', 'https://other.example.org']
  for (const graphOrigin of addresses) {
    const tag = sandbox({ graphOrigin })
    assert.deepEqual(tag.injections, [], graphOrigin)
    assert.deepEqual(tag.outcomes, ['failure'], graphOrigin)
  }
  for (const denyPermission of ['inject_script', 'access_consent', 'access_globals']) {
    const refused = sandbox({}, { denyPermission })
    assert.deepEqual(refused.injections, [], denyPermission)
    assert.deepEqual(refused.outcomes, ['failure'], denyPermission)
  }
})

test('invalid resolved fields cannot broaden a page list or silently disable consent', () => {
  for (const fields of [{ allowPages: ['/support'] }, { allowPages: ', /support' }, { refusePages: '/private, ' }, { refusePages: '/private/\ud800' }, { events: 'inquiry,,text_click' }, { forms: 'on' }, { requireConsent: 'false' }, { text: 1 }]) {
    const tag = sandbox(fields)
    assert.deepEqual(tag.injections, [], JSON.stringify(fields))
    assert.deepEqual(tag.outcomes, ['failure'], JSON.stringify(fields))
  }
})

test('an unavailable collector or missing consent method reports a failed firing', () => {
  const download = sandbox()
  download.injections[0]!.failed()
  download.change('ad_storage', false)
  assert.deepEqual(download.storage, [])
  assert.deepEqual(download.outcomes, ['failure'])

  const old = sandbox({}, { missingSetter: true })
  old.injections[0]!.loaded()
  assert.deepEqual(old.outcomes, ['failure'])
})
