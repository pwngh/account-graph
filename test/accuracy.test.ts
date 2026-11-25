import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INTAKE, SETTINGS } from '../tools/accuracy/rates.ts'
import { PLAIN, play, report } from '../tools/accuracy/run.ts'
import { interval, score } from '../tools/accuracy/score.ts'
import { asked, makeWorld } from '../tools/accuracy/world.ts'

const contact = (n: number, people: string[], ...facts: string[]) => ({ subject: `contact:${n}`, people, facts })

test('what is found, missed and wrong is counted by pair and by person', () => {
  const truths = [
    contact(1, ['pat'], 'phone 1'),
    contact(2, ['pat'], 'phone 1', 'email 2'),
    contact(3, ['pat'], 'email 3'),
    contact(4, ['lee'], 'email 2'),
    { subject: 'caller:1', people: ['lee'], facts: ['phone 4'] },
  ]
  const clusters = new Map([['contact:1', 'a'], ['contact:2', 'a'], ['contact:4', 'a'], ['contact:3', 'b'], ['caller:1', 'c']])
  const { all, kinds, people, mixed, recorded, mixedRecords, wrongClusters, clusters: many } = score(truths, clusters)
  assert.deepEqual(all, { same: 4, joinable: 1, found: 1, foundJoinable: 1, wrong: 2 })
  assert.deepEqual(kinds.get('caller contact'), { same: 1, joinable: 0, found: 0, foundJoinable: 0, wrong: 0 })
  assert.deepEqual([people, mixed, wrongClusters, many], [2, 2, 1, 3])
  assert.deepEqual([recorded, mixedRecords], [2, 2])
})

test('two people who truly share a browser are not a wrong join by it, and are one when nothing is shared', () => {
  const browser = { subject: 'visitor:1', people: ['pat', 'lee'], facts: ['device 1'] }
  const truths = [contact(1, ['pat'], 'device 1'), browser, contact(2, ['lee'], 'device 1')]
  const { all, mixed } = score(truths, new Map(truths.map((each) => [each.subject, 'a'])))
  // The browser belongs with both. The two contacts do not belong together.
  assert.deepEqual(all, { same: 2, joinable: 2, found: 2, foundJoinable: 2, wrong: 1 })
  assert.equal(mixed, 2)
  // Both share two things: one pair, counted once.
  const telephone = { subject: 'caller:1', people: ['lee', 'pat'], facts: ['phone 1'] }
  assert.deepEqual(score([browser, telephone], new Map()).all, { same: 1, joinable: 0, found: 0, foundJoinable: 0, wrong: 0 })
})

test('a fact reached through another of the same person\'s subjects makes a pair joinable', () => {
  const truths = [contact(1, ['pat'], 'phone 1'), contact(2, ['pat'], 'phone 1', 'email 2'), contact(3, ['pat'], 'email 2'), contact(4, ['lee'], 'email 9', 'phone 1')]
  assert.deepEqual(score(truths, new Map()).all, { same: 3, joinable: 3, found: 0, foundJoinable: 0, wrong: 0 })
})

test('a subject the graph never heard of is alone', () => {
  const truths = [contact(1, ['pat'], 'x'), contact(2, ['lee'], 'x')]
  assert.deepEqual(score(truths, new Map()).all, { same: 0, joinable: 0, found: 0, foundJoinable: 0, wrong: 0 })
})

test('two people of whom one spoke for the other are counted with the rest, and left out of the second figure', () => {
  const truths = [contact(1, ['pat'], 'a'), contact(2, ['lee'], 'a'), contact(3, ['kim'], 'a')]
  const together = new Map([['contact:1', 'x'], ['contact:2', 'x']])
  const { mixedRecords, mixedApart } = score(truths, together, new Set(['lee pat']))
  assert.deepEqual([mixedRecords, mixedApart], [2, 0])
  // A third who is nobody's speaker mixes all three.
  assert.equal(score(truths, new Map([...together, ['contact:3', 'x']]), new Set(['lee pat'])).mixedApart, 3)
})

test('the plain rules join what they look at', () => {
  const truths = [contact(1, ['pat'], 'phone 1', 'device 1'), contact(2, ['lee'], 'phone 1'), contact(3, ['kim'], 'device 1'), { subject: 'visitor:1', people: ['kim'], facts: ['device 1', 'tap c'] }, { subject: 'caller:1', people: ['sam'], facts: ['tap c'] }]
  const groups = (joined: Map<string, string>) => truths.map(({ subject }) => truths.filter((other) => joined.get(other.subject) === joined.get(subject)).length)
  assert.deepEqual(groups(PLAIN['any shared fact'](truths)), [4, 4, 4, 4, 1])
  assert.deepEqual(groups(PLAIN['same phone or email'](truths)), [2, 2, 1, 1, 1])
})

test('an interval is wider the more the worlds differ', () => {
  const { mean, low, high } = interval([1, 2, 3])
  assert.equal(mean, 2)
  assert.ok(Math.abs(high - (2 + 4.303 / Math.sqrt(3))) < 1e-9 && Math.abs(low - (2 - 4.303 / Math.sqrt(3))) < 1e-9)
  assert.deepEqual(interval([5, 5]), { mean: 5, low: 5, high: 5 })
  assert.throws(() => interval([1]), TypeError)
})

test('a world is the same for the same seed, and every subject of it has an owner', () => {
  const size = { people: 200, days: 60, start: Date.parse('2026-03-02T15:00:00Z'), seed: 7 }
  const { events, truths, calls } = makeWorld(SETTINGS.high!.rates, size)
  assert.deepEqual(makeWorld(SETTINGS.high!.rates, size).events, events)
  assert.notDeepEqual(makeWorld(SETTINGS.high!.rates, { ...size, seed: 8 }).events, events)
  assert.deepEqual(events.map((event) => event.at), events.map((event) => event.at).sort((x, y) => x - y))
  assert.ok(truths.every((each) => each.people.length > 0 && each.facts.length > 0))
  const told = new Set(truths.map((each) => each.subject))
  for (const event of events) {
    if (event.kind === 'record') assert.ok(told.has(event.subject))
    else if (event.kind === 'call') assert.ok(calls.has(event.id))
    else if (event.kind === 'join') assert.ok(calls.has(event.call) && told.has(event.subject))
    else if (event.kind === 'speaks') assert.ok(told.has(event.subject))
    else if (event.kind === 'merge') assert.ok(told.has(event.a) && told.has(event.b))
    else assert.ok(told.has(`visitor:${event.device}`))
  }
})

test('a world is reported to a server, and everyone told of is found there', async () => {
  const world = makeWorld(SETTINGS.base!.rates, { people: 60, days: 30, start: Date.parse('2026-03-02T15:00:00Z'), seed: 3 })
  for (const arm of ['default', 'household', 'household staff', 'default pool'] as const) {
    const { truths, clusterOf, credit } = await report(world, arm)
    // A caller who hid their number is a subject of its own.
    assert.ok(truths.length >= world.truths.length)
    for (const { subject } of world.truths) assert.ok(clusterOf.has(subject), subject)
    assert.equal(credit.right + credit.wrong + credit.none + credit.cold, world.ads.size)
  }
})

test('under the default policy names and birth dates change no group', async () => {
  const world = makeWorld(SETTINGS.base!.rates, { people: 80, days: 40, start: Date.parse('2026-03-02T15:00:00Z'), seed: 5 })
  const without = { ...world, events: world.events.map((event) => (event.kind === 'record' ? { ...event, name: undefined, dob: undefined } : event)) } as unknown as typeof world
  assert.deepEqual((await report(world)).clusterOf, (await report(without)).clusterOf)
})

test('the third world adds to the others without changing them, and says whose facts are whose', async () => {
  const names = { english: [{ name: 'robert', share: 3, shorts: ['bob', 'rob'] }, { name: 'mary', share: 2, shorts: ['molly'] }], spanish: [{ name: 'guadalupe', share: 1, shorts: ['lupe'], english: [] }], spanishShare: 0.3 }
  const size = { people: 2_000, days: 120, start: Date.parse('2026-03-02T15:00:00Z'), seed: 7 }
  const { events, truths } = makeWorld(SETTINGS.high3!.rates, size, names)
  assert.deepEqual(makeWorld(SETTINGS.high3!.rates, size, names).events, events)
  assert.throws(() => makeWorld(SETTINGS.high3!.rates, size), /list of names/)
  const told = events.filter((event) => event.kind === 'record' && event.speaker)
  assert.ok(told.length > 0)
  // What is said to be the speaker's was given, and is among the facts of the record.
  for (const event of told) {
    if (event.kind !== 'record') continue
    const { facts } = truths.find((each) => each.subject === event.subject)!
    for (const [kind, value] of Object.entries(event.speaker!)) assert.ok(facts.includes(`${kind} ${value}`) || kind === 'phone', `${kind} of ${event.subject}`)
  }
  const reported = events.map((event) => (event.kind === 'call' && event.told) || event.at)
  assert.deepEqual(reported, [...reported].sort((x, y) => x - y))
  // Nobody who does not ask hears of a speaker.
  const world = makeWorld(SETTINGS.base3!.rates, { ...size, people: 60, days: 30 }, names)
  const { clusterOf } = await report(world)
  for (const { subject } of world.truths) assert.ok(clusterOf.has(subject), subject)
})

test('what staff do at intake adds to a world, names its people and is reported', async () => {
  const size = { people: 1_000, days: 120, start: Date.parse('2026-03-02T15:00:00Z'), seed: 7 }
  const world = makeWorld(SETTINGS.high!.rates, size)
  const taken = asked(world, INTAKE, 7)
  assert.deepEqual(asked(world, INTAKE, 7), taken)
  assert.deepEqual(asked(world, { asks: 0, says: 0, saysWrongly: 0, opened: 0, openedWrong: 0, merged: 0, mergedWrong: 0 }, 7), world)
  // What was there stays, in its order.
  const kept = new Set(world.events)
  assert.deepEqual(taken.events.filter((event) => kept.has(event)), world.events)
  for (const kind of ['join', 'merge', 'speaks'] as const) assert.ok(taken.events.some((event) => event.kind === kind && !kept.has(event)), kind)
  const peopleOf = new Map(taken.truths.map(({ subject, people }) => [subject, people]))
  for (const event of taken.events) if (event.kind === 'join' && event.intake) assert.ok(peopleOf.has(event.subject))
  const { clusterOf } = await play(taken, { intake: true }, 10, await import('../src/index.ts').then(async (index) => ({ ...index, ...(await import('../src/server.ts')) })))
  for (const { subject } of taken.truths) assert.ok(clusterOf.has(subject), subject)
})

test('a tie is held to the call it rests on, and not to everybody the line has been', async () => {
  const at = Date.parse('2026-03-02T15:00:00Z')
  const page = { address: '198.51.100.7', agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile Safari' }
  const events = [
    { kind: 'visit' as const, at, device: 'd1', ...page },
    { kind: 'tap' as const, at: at + 60_000, device: 'd1', ...page },
    { kind: 'call' as const, at: at + 70_000, id: 'c1', from: '+15552000001', seconds: 90, answered: true, people: ['pat'] },
    { kind: 'visit' as const, at: at + 3_600_000, device: 'd2', ...page },
    { kind: 'tap' as const, at: at + 3_660_000, device: 'd2', ...page },
    { kind: 'call' as const, at: at + 3_670_000, id: 'c2', from: '+15552000001', seconds: 90, answered: true, people: ['lee'] },
  ]
  const told = (truth: string[]) => ({ events, truths: [{ subject: 'visitor:d1', people: ['pat'], facts: ['device d1'] }, { subject: 'visitor:d2', people: truth, facts: ['device d2'] }], calls: new Map([['c1', { people: ['pat'], facts: [], about: 'pat' }], ['c2', { people: ['lee'], facts: [], about: 'lee' }]]), spoke: new Set<string>(), ads: new Map(), written: new Map(), who: new Map() })
  const { tapLinks } = await report(told(['pat']) as never)
  // One line, two callers. The second browser is Pat's, and Lee's call is what ties it.
  assert.deepEqual(tapLinks, { links: 2, wrong: 1 })
  assert.deepEqual((await report(told(['lee']) as never)).tapLinks, { links: 2, wrong: 0 })
})
