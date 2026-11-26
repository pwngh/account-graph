___INFO___

{
  "type": "TAG",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "Account Graph browser tag",
  "brand": { "id": "brand_dummy", "displayName": "" },
  "description": "Load the browser collector from your graph when advertising and analytics storage are both allowed.",
  "containerContexts": ["WEB"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT", "name": "graphOrigin", "displayName": "Graph address", "simpleValueType": true,
    "help": "Enter the HTTPS origin approved in the template's script permission, for example https://graph.example.org.",
    "valueValidators": [{ "type": "NON_EMPTY" }]
  },
  {
    "type": "SELECT", "name": "forms", "displayName": "Forms to fill", "simpleValueType": true, "defaultValue": "marked",
    "selectItems": [
      { "value": "marked", "displayValue": "Forms marked data-ag-fields" },
      { "value": "all", "displayValue": "Marked forms and every POST form" }
    ]
  },
  {
    "type": "TEXT", "name": "allowPages", "displayName": "Allowed pages", "simpleValueType": true,
    "help": "Optional comma-separated paths, such as /pricing,/help/*. The graph's server page lists take precedence."
  },
  {
    "type": "TEXT", "name": "refusePages", "displayName": "Refused pages", "simpleValueType": true,
    "help": "Optional comma-separated paths, such as /help/private/*,/account. A refusal wins over an allowance."
  },
  {
    "type": "CHECKBOX", "name": "requireConsent", "checkboxText": "Also require the graph banner's ad user data consent", "simpleValueType": true, "defaultValue": false
  },
  {
    "type": "TEXT", "name": "events", "displayName": "Events to send", "simpleValueType": true,
    "help": "Enter comma-separated names accepted by the graph, such as phone_click,text_click,inquiry. Leave blank to send no page events."
  },
  {
    "type": "CHECKBOX", "name": "text", "checkboxText": "Add the visitor's code to text links", "simpleValueType": true, "defaultValue": false,
    "help": "Requires TEXT_CODES=true on the graph."
  }
]

___SANDBOXED_JS_FOR_WEB_TEMPLATE___

const isConsentGranted = require('isConsentGranted')
const addConsentListener = require('addConsentListener')
const queryPermission = require('queryPermission')
const parseUrl = require('parseUrl')
const encode = require('encodeUriComponent')
const injectScript = require('injectScript')
const callInWindow = require('callInWindow')

if (!queryPermission('access_consent', 'read', 'ad_storage') || !queryPermission('access_consent', 'read', 'analytics_storage')) return data.gtmOnFailure()
const storageGranted = () => isConsentGranted('ad_storage') && isConsentGranted('analytics_storage')
if (!storageGranted()) return data.gtmOnSuccess()

const graph = typeof data.graphOrigin === 'string' && parseUrl(data.graphOrigin)
if (!graph || graph.protocol !== 'https:' || (data.graphOrigin !== graph.origin && data.graphOrigin !== graph.origin + '/')) return data.gtmOnFailure()

const list = value => {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string') return undefined
  if (!value.trim()) return ''
  const entries = value.split(',').map(item => item.trim())
  if (entries.indexOf('') !== -1) return undefined
  return encode(entries.join(','))
}
const events = list(data.events)
const allow = list(data.allowPages)
const refuse = list(data.refusePages)
if (events === undefined || allow === undefined || refuse === undefined) return data.gtmOnFailure()
if (data.forms !== undefined && data.forms !== 'marked' && data.forms !== 'all') return data.gtmOnFailure()
if (data.requireConsent !== undefined && typeof data.requireConsent !== 'boolean') return data.gtmOnFailure()
if (data.text !== undefined && typeof data.text !== 'boolean') return data.gtmOnFailure()

let url = graph.origin + '/collect.js?gtm=1&events=' + events
if (data.forms === 'all') url += '&forms=all'
if (allow) url += '&allowPages=' + allow
if (refuse) url += '&refusePages=' + refuse
if (data.requireConsent) url += '&consent=required'
if (data.text) url += '&text=1'

const gate = 'accountGraph.setStorageGranted'
if (!queryPermission('inject_script', url) || !queryPermission('access_globals', 'execute', gate)) return data.gtmOnFailure()

// Remember withdrawals during download and check both current grants when one update changes the pair.
let loaded = false
let ads = true
let analytics = true
const allowed = () => ads && analytics && storageGranted()
const changed = (type, granted) => {
  if (type === 'ad_storage') ads = granted
  if (type === 'analytics_storage') analytics = granted
  if (loaded) callInWindow(gate, allowed())
}
addConsentListener('ad_storage', changed)
addConsentListener('analytics_storage', changed)
injectScript(url, () => {
  loaded = true
  if (callInWindow(gate, allowed()) === true) data.gtmOnSuccess()
  else data.gtmOnFailure()
}, data.gtmOnFailure, 'account-graph.gtm')

___WEB_PERMISSIONS___

[
  {
    "instance": {
      "key": { "publicId": "inject_script", "versionId": "1" },
      "param": [{
        "key": "urls", "value": { "type": "LIST", "listItem": [
          { "type": "TEMPLATE", "template": "https://graph.example.org/collect.js?gtm=1&*" }
        ] }
      }]
    },
    "clientAnnotations": { "isEditedByUser": true }
  },
  {
    "instance": {
      "key": { "publicId": "access_consent", "versionId": "1" },
      "param": [{
        "key": "consentTypes", "value": { "type": "LIST", "listItem": [
          {
            "type": "MAP",
            "mapKey": [{ "type": "TEMPLATE", "template": "consentType" }, { "type": "TEMPLATE", "template": "read" }, { "type": "TEMPLATE", "template": "write" }],
            "mapValue": [{ "type": "TEMPLATE", "template": "ad_storage" }, { "type": "BOOLEAN", "boolean": true }, { "type": "BOOLEAN", "boolean": false }]
          },
          {
            "type": "MAP",
            "mapKey": [{ "type": "TEMPLATE", "template": "consentType" }, { "type": "TEMPLATE", "template": "read" }, { "type": "TEMPLATE", "template": "write" }],
            "mapValue": [{ "type": "TEMPLATE", "template": "analytics_storage" }, { "type": "BOOLEAN", "boolean": true }, { "type": "BOOLEAN", "boolean": false }]
          }
        ] }
      }]
    },
    "clientAnnotations": { "isEditedByUser": true }
  },
  {
    "instance": {
      "key": { "publicId": "access_globals", "versionId": "1" },
      "param": [{
        "key": "keys", "value": { "type": "LIST", "listItem": [
          {
            "type": "MAP",
            "mapKey": [{ "type": "TEMPLATE", "template": "key" }, { "type": "TEMPLATE", "template": "read" }, { "type": "TEMPLATE", "template": "write" }, { "type": "TEMPLATE", "template": "execute" }],
            "mapValue": [{ "type": "TEMPLATE", "template": "accountGraph.setStorageGranted" }, { "type": "BOOLEAN", "boolean": false }, { "type": "BOOLEAN", "boolean": false }, { "type": "BOOLEAN", "boolean": true }]
          }
        ] }
      }]
    },
    "clientAnnotations": { "isEditedByUser": true }
  }
]

___TESTS___

scenarios:
- name: Granted storage loads the graph with the selected fields
  code: |-
    mock('queryPermission', () => true)
    mock('isConsentGranted', () => true)
    mock('addConsentListener', () => {})
    mock('injectScript', (url, loaded) => loaded())
    mock('callInWindow', () => true)
    runCode({graphOrigin: 'https://graph.example.org', forms: 'all', events: 'phone_click', requireConsent: true})
    assertApi('injectScript').wasCalled()
    assertApi('callInWindow').wasCalledWith('accountGraph.setStorageGranted', true)
    assertApi('gtmOnSuccess').wasCalled()
    assertApi('gtmOnFailure').wasNotCalled()
- name: Either denied storage type skips the download
  code: |-
    mock('queryPermission', () => true)
    mock('isConsentGranted', type => type === 'ad_storage')
    runCode({graphOrigin: 'https://graph.example.org'})
    assertApi('injectScript').wasNotCalled()
    assertApi('gtmOnSuccess').wasCalled()
- name: A graph outside the script permission fails
  code: |-
    mock('isConsentGranted', () => true)
    mock('queryPermission', permission => permission !== 'inject_script')
    runCode({graphOrigin: 'https://other.example.org'})
    assertApi('injectScript').wasNotCalled()
    assertApi('gtmOnFailure').wasCalled()
