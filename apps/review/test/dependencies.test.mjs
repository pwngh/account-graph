import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = name => JSON.parse(readFileSync(new URL('../' + name, import.meta.url), 'utf8'))

test('the app installs only what it uses, and the lockfile agrees with package.json', () => {
  const app = read('package.json')
  const { packages } = read('package-lock.json')
  assert.deepEqual(Object.keys(app.dependencies).sort(), ['@react-router/node', 'react', 'react-dom', 'react-router'])
  assert.deepEqual(Object.keys(app.devDependencies).sort(), ['@react-router/dev', '@types/node', '@types/react', '@types/react-dom', 'typescript', 'vite'])
  assert.deepEqual(packages[''].dependencies, app.dependencies)
  assert.deepEqual(packages[''].devDependencies, app.devDependencies)
  // The production server is server.mjs on @react-router/node. Nothing installs the Express server or its tree.
  for (const name of ['@react-router/serve', '@react-router/express', '@react-router/fs-routes', 'express']) assert.equal(packages['node_modules/' + name], undefined, name)
})

test('npm start serves the built app with the Node request handler', { timeout: 30000 }, async t => {
  assert.equal(read('package.json').scripts.start, 'node server.mjs')
  const server = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, NODE_ENV: 'production', PORT: '0', HOST: '127.0.0.1', REVIEW_SESSION_SECRET: 'a-start-script-secret-of-forty-characters' }, stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => server.kill())
  let said = ''
  for await (const chunk of server.stdout) {
    said += chunk
    if (/port \d+/.test(said)) break
  }
  const port = /port (\d+)/.exec(said)?.[1]
  assert.ok(port, said)
  const answer = await fetch('http://127.0.0.1:' + port + '/signin')
  assert.equal(answer.status, 200)
  assert.match(await answer.text(), /Reviewer token/)
  server.kill()
  await once(server, 'exit')
})
