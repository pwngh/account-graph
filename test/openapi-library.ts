import ts from 'typescript'
import type { LookupValue } from '../src/contract/api.ts'

// Read the literal requests in one example. Code that handles the replies never has to run.
export function libraryRequests(body: string): { call: string, payload: unknown }[] {
  const source = ts.createSourceFile('example.ts', body, ts.ScriptTarget.Latest, true)
  const bindings = new Map<string, () => unknown>()
  const requests: { call: string, payload: unknown }[] = []

  function method(node: ts.Expression) {
    return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'graph' ? node.name.text : undefined
  }

  function member(object: unknown, field: string): unknown {
    if (object && typeof object === 'object' && Object.hasOwn(object, field)) return (object as Record<string, unknown>)[field]
    throw new Error('Missing example field ' + field)
  }

  function value(node: ts.Expression): unknown {
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (node.kind === ts.SyntaxKind.NullKeyword) return null
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (ts.isIdentifier(node) && bindings.has(node.text)) return bindings.get(node.text)!()
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(value)
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(property => {
      if (ts.isShorthandPropertyAssignment(property)) return [property.name.text, value(property.name)]
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return [property.name.text, value(property.initializer)]
      throw new Error('Unsupported request property ' + property.getText(source))
    }))
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return value(node.left) ?? value(node.right)
    if (ts.isPropertyAccessExpression(node)) {
      const object = value(node.expression)
      return object == null && node.questionDotToken ? undefined : member(object, node.name.text)
    }
    // The next write uses a field read from the graph. Supply a possible value for each documented lookup.
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) && method(node.expression.expression) === 'lookup') {
      const kind = member(value(node.expression.arguments[0]!), 'kind')
      if (kind === 'person') return { decisions: 0, people: [] } satisfies LookupValue['person']
      if (kind === 'party') return { role: 'unknown', by: 'intake', at: 1795460200000, key: 'desk-017' } satisfies LookupValue['party']
    }
    throw new Error('Unsupported request expression ' + node.getText(source))
  }

  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer
      if (ts.isIdentifier(node.name)) bindings.set(node.name.text, () => value(init))
      if (ts.isObjectBindingPattern(node.name)) for (const part of node.name.elements) {
        if (ts.isIdentifier(part.name)) bindings.set(part.name.text, () => member(value(init), (part.propertyName ?? part.name).getText(source)))
      }
    }
    if (ts.isCallExpression(node)) {
      const call = method(node.expression)
      if (call && call !== 'close') {
        const arg = node.arguments[0]
        if (!arg) throw new Error('Missing argument to graph.' + call)
        // The retry example passes its function parameter through. It supplies no example payload.
        const wrapper = ts.findAncestor(node, ts.isFunctionDeclaration)
        const parameter = ts.isIdentifier(arg) && wrapper?.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === arg.text)
        if (!parameter) requests.push({ call, payload: value(arg) })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return requests
}
