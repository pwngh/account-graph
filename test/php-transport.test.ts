import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { createServer as tcpServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const installed = spawnSync('php', ['-r', "echo PHP_VERSION_ID . ' ' . (int)extension_loaded('openssl') . ' ' . (int)extension_loaded('curl');"], { encoding: 'utf8' })
const [version, openssl, curl] = (installed.stdout ?? '').split(' ').map(Number)
const skip = (installed.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && 'php is not on the PATH'

async function php(code: string, args: string[] = [], ini: string[] = []) {
  const { stdout, stderr } = await run('php', [...ini.flatMap(value => ['-d', value]), '-r', "require 'examples/php/AccountGraph.php';\n" + code, ...args], { cwd: root, timeout: 8000, env: { ...process.env, NO_PROXY: '*', no_proxy: '*' } })
  assert.equal(stderr, '')
  return JSON.parse(stdout)
}

async function serve(t: TestContext, server: Server) {
  const sockets = new Set<Socket>()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    const closed = once(server, 'close')
    server.close()
    for (const socket of sockets) socket.destroy()
    await closed
  })
  return '127.0.0.1:' + (server.address() as AddressInfo).port
}

const read = `
try {
    $client = new AccountGraph($argv[1], 'synthetic-transport', 500, 700, 2);
    echo json_encode($client->lookup(array('kind' => 'party', 'call' => 'missing')));
} catch (AccountGraphFault $fault) {
    echo json_encode(array('code' => $fault->faultCode, 'retryable' => $fault->retryable, 'detail' => $fault->detail));
}`
const transports = () => curl ? [[], ['disable_functions=curl_init']] : [[]]

test('PHP gives the graph time to finish a batch and redacts the constructor token in exception traces', { skip }, async () => {
  const answer = await php(`
$constructor = new ReflectionMethod('AccountGraph', '__construct');
$params = $constructor->getParameters();
$token = 'synthetic-token-for-trace';
try {
    new AccountGraph('invalid', $token);
} catch (AccountGraphFault $fault) {
    echo json_encode(array(
        'redacted' => strpos($fault->getTraceAsString(), $token) === false,
        'attribute' => PHP_VERSION_ID < 80200 || count($params[1]->getAttributes('SensitiveParameter')) === 1,
        'timeout' => $params[3]->getDefaultValue()
    ));
}`, [], ['zend.exception_ignore_args=0', 'zend.exception_string_param_max_len=1024'])
  assert.equal(answer.redacted, true)
  assert.equal(answer.attribute, true)
  assert.ok(answer.timeout > 30000)
})

test('PHP waits for Retry-After seconds or dates and returns longer waits to the worker', { skip }, async t => {
  let hint = ''
  let earliest = 0
  const dates: number[] = []
  const url = 'http://' + await serve(t, createServer((_req, res) => {
    const now = Date.now()
    dates.push(now)
    if (dates.length > 1) return res.end('null')
    if (hint === 'closed') return res.writeHead(503, { 'retry-after': '3600' }).end(JSON.stringify({ fault: { code: 'GRAPH.CLOSED', retryable: false, detail: {} } }))
    const header = hint === 'date' ? new Date(now + 1800).toUTCString() : hint === 'past' ? new Date(now - 60000).toUTCString() : hint
    earliest = hint === 'date' ? Date.parse(header) : now + (hint === '1' ? 1000 : 50)
    res.writeHead(503, { 'retry-after': header, 'content-type': 'application/json' }).end(JSON.stringify({ fault: { code: 'GRAPH.UNAVAILABLE', retryable: true, detail: {} } }))
  }))
  for (const ini of transports()) {
    for (hint of ['1', 'date', '0', '-1', 'past', '3600', 'closed']) {
      dates.length = 0
      const answer = await php(read, [url], ini)
      if (hint === 'closed') {
        assert.deepEqual(answer, { code: 'GRAPH.CLOSED', retryable: false, detail: { retryAfter: '3600' } })
        assert.equal(dates.length, 1)
      } else if (hint === '3600') {
        assert.deepEqual(answer, { code: 'GRAPH.UNAVAILABLE', retryable: true, detail: { retryAfter: hint } })
        assert.equal(dates.length, 1)
      } else {
        assert.equal(answer, null)
        assert.equal(dates.length, 2)
        assert.ok(dates[1]! >= earliest, 'the next request arrived before Retry-After')
      }
    }
  }
})

test('PHP caps Retry-After dates and delta-seconds at fifteen minutes', { skip }, async () => {
  const { start, deadlines, end } = await php(`
$start = microtime(true);
$deadlines = array_map(array('AccountGraph', 'retryAt'), array('86400', 'Fri, 31 Dec 9999 23:59:59 GMT', '99999999999999999999999'));
echo json_encode(array('start' => $start, 'deadlines' => $deadlines, 'end' => microtime(true)));`)
  for (const until of deadlines) assert.ok(until >= start + 900 && until <= end + 900)
})

test('PHP keeps certificate verification failures separate from a TLS handshake timeout', { skip: skip || (!openssl && 'the PHP OpenSSL extension is not loaded') }, async t => {
  // Make a fresh local certificate so this tests a real verification failure with no checked-in private key.
  const pem = await php(`
$options = array('config' => 'test/fixtures/php/openssl.cnf', 'private_key_bits' => 2048, 'digest_alg' => 'sha256');
$key = openssl_pkey_new($options);
$csr = openssl_csr_new(array('commonName' => 'localhost'), $key, $options);
$cert = openssl_csr_sign($csr, null, $key, 1, $options);
openssl_x509_export($cert, $certificate);
openssl_pkey_export($key, $private);
echo json_encode(array('cert' => $certificate, 'key' => $private));`)
  const tls = httpsServer(pem)
  let connections = 0
  tls.on('connection', () => connections++)
  const untrusted = 'https://' + await serve(t, tls)
  const stalled = 'https://' + await serve(t, tcpServer(socket => socket.resume()))
  for (const ini of transports()) {
    connections = 0
    assert.deepEqual(await php(read, [untrusted], ini), { code: 'CONFIG.INVALID', retryable: false, detail: { stage: 'tls' } })
    assert.equal(connections, 1)
    const timeout = await php(read, [stalled], ini)
    assert.equal(timeout.code, 'TRANSPORT.INDETERMINATE')
    assert.equal(timeout.retryable, true)
  }
})

test('PHP disables cURL signals for sub-second deadlines', { skip: skip || (!curl && 'the PHP cURL extension is not loaded') || (version! < 80000 && 'PHP 8 is needed to inspect options on the live handle') }, async t => {
  const url = 'http://' + await serve(t, createServer((_req, res) => res.end('null')))
  const noSignals = await php(`
function curl_setopt_array($handle, $options) {
    $GLOBALS['no_signals'] = $options[CURLOPT_NOSIGNAL] ?? false;
    foreach ($options as $name => $value) {
        if (!curl_setopt($handle, $name, $value)) return false;
    }
    return true;
}
$client = new AccountGraph($argv[1], 'synthetic-transport', 100, 200, 1);
$client->lookup(array('kind' => 'party', 'call' => 'missing'));
echo json_encode($GLOBALS['no_signals']);`, [url], ['disable_functions=curl_setopt_array'])
  assert.equal(noSignals, true)
})
