import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { AccountGraph } from '../src/contract/api.ts'

// Instantiate the two generic methods the way a typed caller does. This preserves the answer for each kind, including the report envelope.
declare const graph: AccountGraph
type AnswersByKind = {
  lookup: { [Q in Parameters<typeof graph.lookup>[0] as Q['kind']]: Awaited<ReturnType<typeof graph.lookup<Q>>> }
  report: { [Q in Parameters<typeof graph.report>[0] as Q['kind']]: Awaited<ReturnType<typeof graph.report<Q>>> }
}

export interface Schema {
  $ref?: string
  title?: string
  description?: string
  type?: string
  const?: string | number | boolean
  enum?: (string | number)[]
  anyOf?: Schema[]
  if?: Schema
  then?: Schema
  items?: Schema
  prefixItems?: Schema[]
  minItems?: number
  maxItems?: number
  properties?: Record<string, Schema>
  required?: string[]
  minProperties?: number
  maxProperties?: number
  propertyNames?: Schema
  additionalProperties?: boolean | Schema
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
  minimum?: number
  maximum?: number
}

export interface CallSchemas {
  request: Schema
  response: Schema
}

const config = fileURLToPath(new URL('../tsconfig.json', import.meta.url))
const contractTypes = fileURLToPath(new URL('../src/contract/types.ts', import.meta.url))
const api = fileURLToPath(new URL('../src/contract/api.ts', import.meta.url))
const generator = fileURLToPath(import.meta.url)
const reference = (name: string): Schema => ({ $ref: '#/components/schemas/' + name })
const timestamp: Schema = { type: 'integer', minimum: 0, maximum: 8_640_000_000_000_000 }
const keyLength = { minLength: 1, maxLength: 200 }

// These configure a process, carry a signal or receive a webhook. None is a JSON argument or answer to a call.
const local = new Set(['AccountGraph', 'CallOptions', 'Common', 'RemoteOptions', 'LocalOptions', 'InPostgres', 'InMemory', 'LocalSettings', 'GoogleServiceAccount', 'OpenHours', 'RuleOptions', 'BuiltInKind', 'PolicyOptions', 'RawWebhook'])

function includesAt(node: ts.TypeNode): boolean {
  if (ts.isUnionTypeNode(node)) return node.types.some(includesAt)
  return ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'At'
}

// A mapped RecordResult distributes the same refusals over every entry type. Print each distinct refusal shape once.
function groupEntryTypes(options: Schema[]): Schema[] {
  const groups = new Map<string, { option: Schema, types: string[] }>()
  const result: Schema[] = []
  for (const option of options) {
    const tag = option.properties?.type?.const
    if (!option.properties || typeof tag !== 'string') {
      result.push(option)
      continue
    }
    const key = JSON.stringify({ ...option, properties: { ...option.properties, type: undefined } })
    const previous = groups.get(key)
    if (previous) {
      previous.types.push(tag)
      previous.option.properties!.type = { type: 'string', enum: previous.types }
    } else {
      const copy = { ...option, properties: { ...option.properties } }
      groups.set(key, { option: copy, types: [tag] })
      result.push(copy)
    }
  }
  return result
}

export function contractSchemas(): { schemas: Record<string, Schema>, calls: Record<string, CallSchemas> } {
  const read = ts.readConfigFile(config, ts.sys.readFile)
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  const options = ts.convertCompilerOptionsFromJson(read.config.compilerOptions, fileURLToPath(new URL('../', import.meta.url)))
  const program = ts.createProgram([api, generator], options.options)
  const checker = program.getTypeChecker()
  const errors = [...options.errors, ...ts.getPreEmitDiagnostics(program)]
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: name => name, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n' }))
  const source = program.getSourceFile(api)!
  const exported = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!)
  const roots = new Map<string, ts.Type>()
  const names = new Map<ts.Type, string>()
  function register(name: string, type: ts.Type) {
    if (roots.has(name) && roots.get(name) !== type) throw new Error('Conflicting schema names for ' + name)
    roots.set(name, type)
    // TypeScript interns primitives. Registering the alias At for number would make every price and score a timestamp.
    if (type.isUnionOrIntersection() || type.flags & ts.TypeFlags.Object) names.set(type, name)
  }
  for (const symbol of exported) {
    if (!local.has(symbol.name)) register(symbol.name, checker.getDeclaredTypeOfSymbol(symbol))
  }

  // Reuse these shapes when the same result is reached through both its type map and its method signature.
  for (const [name, type] of [...roots]) {
    if (!['LookupValue', 'ReportValue'].includes(name)) continue
    for (const property of type.getProperties()) {
      const value = checker.getTypeOfSymbol(property)
      if (!names.has(value)) register(name.slice(0, -5) + property.name[0]!.toUpperCase() + property.name.slice(1) + 'Value', value)
    }
  }

  function schema(type: ts.Type, expand = false, fieldUsesAt = false): Schema {
    const name = names.get(type)
    if (name && !expand) return reference(name)
    // Reports share named row and total types that are reachable through the API but are not re-exported.
    const symbol = type.aliasSymbol ?? type.getSymbol()
    if (!expand && !name && symbol && !roots.has(symbol.name) && symbol.declarations?.some(node => node.getSourceFile().fileName === contractTypes && (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))) && checker.getDeclaredTypeOfSymbol(symbol) === type) {
      register(symbol.name, type)
      return reference(symbol.name)
    }
    if (type.flags & ts.TypeFlags.Unknown) return {}
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type)
      return constraint ? schema(constraint) : {}
    }
    if (type.isStringLiteral()) return { type: 'string', const: type.value }
    if (type.isNumberLiteral()) return { type: 'number', const: type.value }
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: 'boolean', const: checker.typeToString(type) === 'true' }
    if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' }
    if (type.flags & ts.TypeFlags.Null) return { type: 'null' }
    if (type.flags & ts.TypeFlags.String) return { type: 'string' }
    if (type.flags & ts.TypeFlags.Number) return fieldUsesAt ? reference('At') : { type: 'number' }
    if (type.isUnion()) {
      // An undefined object field is omitted when serialized. Null remains a possible value.
      const members = type.types.filter(member => !(member.flags & ts.TypeFlags.Undefined))
      if (members.length === 1) return schema(members[0]!, false, fieldUsesAt)
      if (members.every(member => member.isStringLiteral())) return { type: 'string', enum: members.map(member => member.value) }
      if (members.every(member => member.isNumberLiteral())) return { type: 'number', enum: members.map(member => member.value) }
      const alternatives = members.map(member => schema(member, false, fieldUsesAt))
      return { anyOf: name === 'RecordResult' ? groupEntryTypes(alternatives) : alternatives }
    }
    if (checker.isTupleType(type)) {
      const tuple = type as ts.TupleTypeReference
      if (tuple.target.elementFlags.some(flag => flag !== ts.ElementFlags.Required)) throw new Error('Unsupported optional or rest tuple in ' + checker.typeToString(type))
      const prefixItems = checker.getTypeArguments(tuple).map(member => schema(member))
      return { type: 'array', prefixItems, minItems: prefixItems.length, maxItems: prefixItems.length }
    }
    if (checker.isArrayType(type)) return { type: 'array', items: schema(checker.getTypeArguments(type as ts.TypeReference)[0]!) }
    if ((!(type.flags & ts.TypeFlags.Object) && !type.isIntersection()) || type.getCallSignatures().length) throw new Error('Unsupported wire type ' + checker.typeToString(type))

    if (checker.getIndexInfosOfType(type).some(index => !(index.keyType.flags & ts.TypeFlags.String))) throw new Error('Unsupported dictionary keys in ' + checker.typeToString(type))
    const properties: Record<string, Schema> = {}
    const required: string[] = []
    for (const property of type.getProperties()) {
      const value = checker.getTypeOfSymbol(property)
      const declaration = property.declarations?.find(ts.isPropertySignature)
      const at = declaration?.type && includesAt(declaration.type)
      const field = schema(value, false, at)
      const description = ts.displayPartsToString(property.getDocumentationComment(checker))
      properties[property.name] = description ? { ...field, description } : field
      if (!(property.flags & ts.SymbolFlags.Optional) && !(value.isUnion() && value.types.some(member => member.flags & ts.TypeFlags.Undefined))) required.push(property.name)
    }
    const index = type.getStringIndexType()
    // An unbound generic intersection can carry other fields, such as the reason-specific details in Decided<T, R>.
    const extendable = type.isIntersection() && type.types.some(member => member.flags & ts.TypeFlags.TypeParameter)
    return { type: 'object', ...(Object.keys(properties).length ? { properties } : {}), ...(required.length ? { required } : {}), additionalProperties: index ? schema(index) : extendable }
  }

  const generic = program.getSourceFile(generator)!.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'AnswersByKind')!
  const byKind = checker.getTypeAtLocation(generic)
  const graphType = checker.getDeclaredTypeOfSymbol(exported.find(symbol => symbol.name === 'AccountGraph')!)
  const calls: Record<string, CallSchemas> = {}
  for (const method of graphType.getProperties()) {
    if (method.name === 'close') continue
    const signatures = checker.getTypeOfSymbol(method).getCallSignatures()
    const signature = signatures[0]
    if (signatures.length !== 1 || !signature?.parameters[0]) throw new Error('Expected one request signature for ' + method.name)
    const input = checker.getTypeOfSymbol(signature.parameters[0])
    const request = schema(checker.getBaseConstraintOfType(input) ?? input)
    let response: Schema
    if (signature.typeParameters?.length) {
      const answers = byKind.getProperty(method.name)
      if (!answers) throw new Error('Instantiate generic method ' + method.name + ' for its request kinds')
      response = { anyOf: checker.getTypeOfSymbol(answers).getProperties().map(kind => ({ title: kind.name, ...schema(checker.getTypeOfSymbol(kind)) })) }
    } else {
      response = schema(checker.getAwaitedType(signature.getReturnType())!)
    }
    calls[method.name] = { request, response }
  }

  const schemas: Record<string, Schema> = {}
  for (const [name, type] of roots) schemas[name] = schema(type, true)
  addRequestLimits(schemas)
  for (const symbol of exported) {
    const root = schemas[symbol.name]
    if (!root || root.description) continue
    const declaration = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    const description = ts.displayPartsToString(declaration.getDocumentationComment(checker))
    if (description) root.description = description
  }
  return { schemas, calls }
}

// The compiler supplies fields and types. These bounds come from the checks on incoming JSON.
function addRequestLimits(schemas: Record<string, Schema>) {
  if (schemas.At?.type !== 'number') throw new Error('Check the epoch millisecond bounds for the new At type')
  schemas.At = timestamp

  const property = (name: string, field: string): Schema => {
    const found = schemas[name]?.properties?.[field]
    if (!found) throw new Error('Missing contract field ' + name + '.' + field)
    return found
  }
  const integer = (field: Schema, minimum: number, maximum: number) => {
    if (field.type !== 'number') throw new Error('Integer bounds require a number in the contract')
    Object.assign(field, { type: 'integer', minimum, maximum })
  }
  const subject = (field: Schema) => Object.assign(field, { minLength: 1, maxLength: 512, pattern: '^\\S(?:[\\s\\S]*\\S)?$', description: 'At most 512 UTF-8 bytes, with no surrounding whitespace.' })
  const limitsOnMap = (field: Schema, maxProperties: number, namePattern: string, values: Schema) => {
    if (typeof field.additionalProperties !== 'object') throw new Error('Expected a dictionary in the contract')
    field.maxProperties = maxProperties
    field.propertyNames = { pattern: namePattern }
    Object.assign(field.additionalProperties, values)
  }

  Object.assign(property('RecordRequest', 'entries'), { minItems: 1, maxItems: 100 })
  Object.assign(property('CostEntry', 'rows'), { minItems: 1, maxItems: 5000 })
  integer(property('EventsRequest', 'limit'), 1, 1000)
  integer(property('TransferEntry', 'amount'), 1, Number.MAX_SAFE_INTEGER)
  Object.assign(property('PaymentEntry', 'amount'), { minimum: 0.00001, maximum: 10_000_000_000 })
  Object.assign(property('ProfileEntry', 'createdAt'), { minimum: 1, description: 'At most one day after at. Only a firm record may have a creation date.' })
  schemas.Speaker!.minProperties = 1
  if (schemas.ProfileEntry!.anyOf) throw new Error('Check the facts requirement for the new profile variants')
  schemas.ProfileEntry!.anyOf = [{ required: ['speaker'] }, { properties: { facts: { minProperties: 1 } } }]
  schemas.CallEntry!.if = { properties: { direction: { const: 'outbound' } } }
  schemas.CallEntry!.then = { required: ['from'] }
  for (const [name, entry] of Object.entries(schemas)) {
    if (!(name === 'Keyed' || name.endsWith('Entry')) || !entry.properties?.key) continue
    Object.assign(entry.properties.key, keyLength)
    if (entry.properties.subject) subject(entry.properties.subject)
    if (entry.properties.tags) {
      limitsOnMap(entry.properties.tags, 8, '^[a-z_]{1,32}$', { minLength: 1, maxLength: 64, pattern: '^(?!\\s*\\(not set\\)\\s*$)[\\s\\S]*\\S' })
    }
  }
  subject(property('TransferEntry', 'from'))
  subject(property('TransferEntry', 'to'))
  for (const change of property('CallUpdateEntry', 'change').anyOf!) {
    if (change.properties?.subject) subject(change.properties.subject)
  }
  limitsOnMap(property('ArrivalEntry', 'custom'), 10, '^[\\w.-]{1,64}$', { minLength: 1, maxLength: 256 })
  for (const entry of ['CallEntry', 'TextEntry']) Object.assign(property(entry, 'key'), { maxLength: 128, pattern: '^[A-Za-z0-9_.-]+$' })
  Object.assign(property('ConversionEntry', 'key'), { pattern: '^(?!(?:call|text|page):)' })

  for (const shape of [schemas.Deciding!, schemas.ForgetRequest!, ...schemas.DecideRequest!.anyOf!]) {
    if (shape.properties?.key) Object.assign(shape.properties.key, keyLength)
    if (shape.properties?.by) Object.assign(shape.properties.by, { minLength: 1, maxLength: 100 })
    if (shape.properties?.reason) Object.assign(shape.properties.reason, { minLength: 1, maxLength: 1000 })
    if (shape.properties?.seen) integer(shape.properties.seen, 0, Number.MAX_SAFE_INTEGER)
    const pairs = shape.properties?.pairs
    if (pairs) {
      Object.assign(pairs, { minItems: 1, maxItems: 1000 })
      subject(pairs.items!.properties!.a!)
      subject(pairs.items!.properties!.b!)
    }
  }
  const forgotten = property('ForgetRequest', 'subjects')
  Object.assign(forgotten, { minItems: 1, maxItems: 50 })
  subject(forgotten.items!)
  for (const option of schemas.LookupRequest!.anyOf!) {
    const fields = option.properties!
    const kind = fields.kind!.const
    if (fields.subject) subject(fields.subject)
    for (const side of ['a', 'b']) if (kind === 'pair') subject(fields[side]!)
    if (kind === 'match') fields.facts!.minProperties = 1
    if (kind === 'conflicts' || kind === 'person') {
      Object.assign(fields.subjects!, { minItems: 1, maxItems: kind === 'person' ? 100 : 50 })
      subject(fields.subjects!.items!)
    }
  }
  for (const field of ['from', 'to']) Object.assign(property('Window', field), { format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' })
  Object.assign(property('Window', 'timeZone'), { minLength: 1, maxLength: 64, description: 'A named time zone, such as America/Chicago.' })
  schemas.Window!.description = 'An inclusive range of calendar days. The first day must be on or before the last.'
  for (const option of schemas.ReportRequest!.anyOf!) {
    if (option.properties?.days) integer(option.properties.days, 1, 365)
  }
}
