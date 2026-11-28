import assert from 'node:assert/strict'
import test from 'node:test'
import { affectsPage, oldBookmark } from '../app/navigation.ts'

test('old bookmarks keep subjects, call anchors, date ranges and original channel controls', () => {
  const convert = hash => oldBookmark(hash, '/review')
  assert.equal(convert('#/accounts/contact%3Aone%2Ftwo'), '/accounts/contact%3Aone%2Ftwo')
  assert.equal(convert('#/journey/contact%3Aone/a%2Fb'), '/journey/contact%3Aone#call-a%252Fb')
  assert.equal(convert('#/calls/2026-10-01/2026-10-31'), '/calls?from=2026-10-01&to=2026-10-31')
  assert.equal(convert('#/channels/2026-10-01/2026-10-31/touch.language/signed/30/client'), '/channels?from=2026-10-01&to=2026-10-31&by=touch.language&step=signed&days=30&per=client')
  assert.equal(convert('#/channels/2026-10-01/2026-10-31'), '/channels?from=2026-10-01&to=2026-10-31')
  assert.equal(convert('#/board'), '/board/90')
  assert.equal(convert('#!channels'), '/channels')
  assert.equal(convert('#contact:one/two'), '/accounts/contact%3Aone%2Ftwo')
  assert.equal(convert('#view'), undefined)
  assert.equal(oldBookmark('#call-a', '/journey/contact:one'), undefined)
  assert.equal(convert('#/channels/2026-10-01/2026-10-31/hour'), '/channels?from=2026-10-01&to=2026-10-31&by=hour')
})

test('live changes refresh the visible report, its details and journeys of related subjects', () => {
  const changed = { views: ['accounts','journey','board'], subjects: ['visitor:42'] }
  assert.equal(affectsPage(changed, '/journey/contact:one', ['contact:one','visitor:42']), true)
  assert.equal(affectsPage(changed, '/journey/contact:one', ['contact:one','visitor:16']), false)
  assert.equal(affectsPage(changed, '/accounts/contact:one', []), true)
  assert.equal(affectsPage(changed, '/details/board/90', []), true)
  assert.equal(affectsPage(changed, '/calls', []), false)
  assert.equal(affectsPage({ views: ['*'], subjects: [] }, '/journey/contact:one', []), true)
  assert.equal(affectsPage({ views: ['*'], subjects: [] }, '/search', []), false)
})
