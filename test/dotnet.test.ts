import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { createEdge } from '../src/edge/index.ts'
import { accountGraph } from '../src/index.ts'

async function listen(server: Server) {
  await once(server.listen(0, '127.0.0.1'), 'listening')
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
}

test('.NET uses the six calls, refuses before sending, and recovers a committed write after a lost reply', { timeout: 300_000 }, async t => {
  const probe = spawnSync('dotnet', ['--version'])
  // CI installs .NET, so there the test runs or fails.
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && !process.env.CI) return t.skip('dotnet is needed for the .NET client integration test')
  assert.ifError(probe.error)

  const graph = accountGraph({ memory: true, now: () => Date.UTC(2026, 0, 1, 1) })
  const edge = createEdge(graph, { token: 'dotnet-test', limit: false })
  const server = createServer(edge)
  t.after(async () => {
    server.closeAllConnections()
    server.close()
    await edge.drain()
    await graph.close()
  })
  const base = await listen(server)

  // Lose the first answer only after the real graph has finished writing.
  const replays: { body: string, duplicate: boolean }[] = []
  const gateway = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      const upstream = await fetch(base + request.url, { method: 'POST', headers: { authorization: request.headers.authorization ?? '', 'content-type': 'application/json' }, body })
      const answer = await upstream.text()
      const first = JSON.parse(answer).results?.[0]
      if (first?.ok && first.key === 'retry-visit') {
        replays.push({ body, duplicate: first.value.duplicate })
        if (replays.length === 1) return response.destroy()
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

  const { stdout } = await promisify(execFile)('dotnet', ['run', '--project', 'clients/dotnet/RealGraph', '--', base, lossy], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' }, timeout: 240_000,
  })
  assert.equal(stdout.trim().split('\n').at(-1), 'ok')
  assert.deepEqual(replays.map(x => x.duplicate), [false, true])
  assert.equal(replays[1]!.body, replays[0]!.body)
})
