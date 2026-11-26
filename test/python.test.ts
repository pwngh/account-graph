import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { createEdge } from '../src/edge/index.ts'
import { accountGraph } from '../src/index.ts'

async function listen(server: Server) {
  await once(server.listen(0, '127.0.0.1'), 'listening')
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
}

test('Python uses the six calls, follows cursors and recovers committed writes after a lost reply and a restart', async t => {
  const probe = spawnSync('python3', ['--version'])
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return t.skip('python3 is needed for the Python client integration test')
  assert.ifError(probe.error)
  assert.equal(probe.status, 0)

  const graph = accountGraph({ memory: true, now: () => Date.UTC(2026, 0, 1, 1) })
  const edge = createEdge(graph, { token: 'python-test', limit: false })
  const server = createServer(edge)
  t.after(async () => {
    server.closeAllConnections()
    server.close()
    await edge.drain()
    await graph.close()
  })
  const base = await listen(server)

  // Lose the first answer only after the real graph has finished writing.
  const replays = new Map<string, { body: string, duplicate: boolean }[]>()
  const gateway = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      const upstream = await fetch(base + request.url, { method: 'POST', headers: { authorization: request.headers.authorization ?? '', 'content-type': 'application/json' }, body })
      const answer = await upstream.text()
      const first = JSON.parse(answer).results?.[0]
      if (first?.ok && ['retry-visit', 'queued-sale'].includes(first.key)) {
        const attempts = replays.get(first.key) ?? []
        attempts.push({ body, duplicate: first.value.duplicate })
        replays.set(first.key, attempts)
        if (attempts.length === 1) return response.destroy()
      }
      response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(answer)
    } catch {
      response.writeHead(500).end()
    }
  })
  t.after(() => {
    gateway.closeAllConnections()
    gateway.close()
  })
  const lossy = await listen(gateway)
  const dir = await mkdtemp(resolve('.python-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const phase of ['write', 'recover']) {
    await promisify(execFile)('python3', ['-B', 'clients/python/tests/real_graph.py', phase, base, lossy, resolve(dir, 'outbox.sqlite')], {
      env: { PATH: process.env.PATH, PYTHONPATH: resolve('clients/python'), PYTHONNOUSERSITE: '1' }, timeout: 60_000,
    })
  }
  for (const key of ['retry-visit', 'queued-sale']) {
    const attempts = replays.get(key)!
    assert.deepEqual(attempts.map(x => x.duplicate), [false, true], key)
    assert.equal(attempts[1]!.body, attempts[0]!.body, key)
  }
})
