import { createRequire } from 'node:module'
import { reactRouter } from '@react-router/dev/vite'
import { defineConfig } from 'vite'

// Resolve the public package exports as a consumer in the checkout, including its Node condition.
const fromGraph = createRequire(new URL('../../package.json', import.meta.url))
export default defineConfig({
  plugins: [reactRouter()],
  resolve: { alias: { 'account-graph': fromGraph.resolve('account-graph') } },
})
