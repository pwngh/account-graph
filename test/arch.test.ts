import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const RINGS = ['contract', 'core', 'store', 'providers', 'client', 'edge', 'testing'] as const
type Ring = (typeof RINGS)[number] | 'root'

/** What each ring may import. Everything points inward. */
const ALLOWED: Record<Ring, readonly Ring[]> = {
  contract: ['contract'],
  core: ['core', 'contract'],
  store: ['store', 'core', 'contract'],
  providers: ['providers', 'core', 'contract'],
  client: ['client', 'store', 'providers', 'core', 'contract'],
  edge: ['edge', 'client', 'store', 'providers', 'core', 'contract'],
  testing: ['testing', 'client', 'core', 'contract'],
  root: ['client', 'contract'],
}
/** `pg` is loaded where a pool is made, and nowhere else. */
const OUTSIDE: Record<Ring, RegExp> = {
  contract: /^$/, core: /^node:/, store: /^node:/, providers: /^node:/, client: /^(node:|pg$)/, edge: /^(node:|pg$)/, testing: /^node:/, root: /^node:/,
}

const ringOf = (path: string): Ring => (RINGS as readonly string[]).includes(path.split(sep)[0]!) ? (path.split(sep)[0] as Ring) : 'root'
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((each) => each.isDirectory() ? files(join(dir, each.name)) : each.name.endsWith('.ts') ? [join(dir, each.name)] : [])
const importsOf = (path: string) => [...readFileSync(path, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1] ?? match[2]!)

describe('every import points inward', () => {
  for (const file of files(SRC)) {
    const name = relative(SRC, file)
    const ring = ringOf(name)
    test(name, () => {
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith('.')) {
          assert.match(specifier, OUTSIDE[ring], `${name} imports '${specifier}'`)
          continue
        }
        const target = relative(SRC, resolve(dirname(file), specifier))
        assert.ok(existsSync(join(SRC, target)), `${name} imports '${specifier}', which is not there`)
        assert.ok(name === 'bin.ts' || ALLOWED[ring].includes(ringOf(target)), `${name} (${ring}) must not import ${target} (${ringOf(target)})`)
      }
    })
  }
})

/** The programs. Everything else is given what it needs. */
const READS_ENVIRONMENT = new Set(['bin.ts'])
test('only a program reads the environment', () => {
  for (const file of files(SRC)) {
    const name = relative(SRC, file).split(sep).join('/')
    if (!READS_ENVIRONMENT.has(name)) assert.doesNotMatch(readFileSync(file, 'utf8'), /process\.env/, name)
  }
})

test('what runs where there is no Node reaches nothing of it', () => {
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:^|\n)(?:import|export) (type )?[^'"\n]*?from\s+['"]([^'"]+)['"]/g)) {
      if (match[1]) continue
      assert.ok(match[2]!.startsWith('.'), `${relative(SRC, file)} needs ${match[2]}`)
      visit(resolve(dirname(file), match[2]!))
    }
  }
  visit(join(SRC, 'remote.ts'))
  assert.ok(seen.size >= 6)
})

test('the package shows these names and these paths, and no others', async () => {
  const manifest = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.exports), ['.', './edge', './collect', './hardware', './testing', './package.json'])
  assert.deepEqual(Object.keys(await import('../src/index.ts')), ['FAULT_CODES', 'accountGraph', 'hasCode', 'isFault', 'parseWebhook', 'verifyWebhook'])
  assert.deepEqual(Object.keys(await import('../src/remote.ts')), ['FAULT_CODES', 'accountGraph', 'hasCode', 'isFault', 'parseWebhook', 'verifyWebhook'])
  assert.deepEqual(Object.keys(await import('../src/testing/index.ts')), ['runWorkers'])
  assert.deepEqual(Object.keys(await import('../src/edge/index.ts')), ['createEdge'])
  assert.deepEqual(Object.keys(await import('../src/edge/hardware.ts')), ['hardwareId'])
})
