// What runs, and what needs someone.
const short = (hash) => (hash === null ? '(not recorded)' : hash === 'mixed' ? 'more than one policy' : hash.slice(0, 12))
const lasting = (ms) => (ms === 'none' ? 'none' : ms >= 86400000 ? `${amount(Math.round(ms / 8640000) / 10)} days` : `${amount(Math.round(ms / 360000) / 10)} hours`)

const NAMES = { touches: 'Arrivals', calls: 'Calls', results: 'Call results', costs: 'Campaign costs' }
const JOB = { running: 'running', stuck: 'never finished', done: 'succeeded', failed: 'failed' }
const ago = (at, now) => (at === null || at === undefined ? el('span', { class: 'muted' }, '(not recorded)') : el('span', { title: when(at) }, `${lasted(now - at)} ago`))

/** Alerts that did not arrive, what feeds the graph, the jobs that run by themselves, and what waits to be sent. */
function workings(ops) {
  const out = []
  if (ops.undelivered.length > 0) {
    out.push(el('section', {}, el('h2', {}, 'Alerts not delivered'),
      el('ul', {}, ...ops.undelivered.map((alert) => el('li', {}, alert.text, el('span', { class: 'reason' }, `${when(alert.at)}${alert.error ? `. ${alert.error}` : ''}`))))))
  }

  const feeds = el('table', {}, el('tr', {}, th('Feed'), th('Last written down'), th('Quiet after'), th('State')),
    ...ops.feeds.map((feed) => el('tr', {}, td('', NAMES[feed.name]), td('', ago(feed.last, ops.at)), td('', feed.hours > 0 ? `${amount(feed.hours)} h` : 'not watched'),
      td('', feed.quiet ? el('span', { class: 'chip apart' }, 'quiet') : feed.hours > 0 ? el('span', { class: 'chip same' }, 'heard from') : ''))))
  out.push(el('section', {}, el('h2', {}, 'Feeds'), wide('Feeds', feeds)))

  const jobs = el('table', {}, el('tr', {}, th('Job'), th('State'), th('Began'), th('Last success'), th('Last failure'), th('Why')),
    ...ops.jobs.map((job) => el('tr', {}, td('', job.name), td('', el('span', { class: `chip ${job.state === 'done' ? 'same' : job.state === 'running' ? '' : 'apart'}` }, JOB[job.state])), td('', ago(job.started, ops.at)),
      td('', ago(job.succeeded, ops.at)), td('', job.failed === undefined ? el('span', { class: 'muted' }, 'none') : ago(job.failed, ops.at)),
      td('who', job.error && job.state === 'failed' ? job.error : '', ...job.open.slice(0, 3).map((began) => el('span', { class: 'reason' }, `A run that began ${when(began)} never finished.`))))))
  out.push(el('section', {}, el('h2', {}, 'Jobs'), ops.jobs.length > 0 ? wide('Jobs', jobs) : el('p', {}, 'None has run yet.')))

  if (ops.pool) {
    const asked = `${amount(ops.pool.leased + ops.pool.exhausted)} ${ops.pool.leased + ops.pool.exhausted === 1 ? 'time' : 'times'} one was asked for since the server started, ${when(ops.pool.since)}`
    out.push(el('section', {}, el('h2', {}, `Number pool, each number for ${amount(ops.pool.minutes)} minutes after the page last asked`), parts('Numbers', [['Shown to a visitor', ops.pool.held], ['Free', ops.pool.numbers - ops.pool.held]]),
      el('p', {}, ...(ops.pool.exhausted > 0 ? [el('b', { class: 'apart' }, `Every number was taken ${amount(ops.pool.exhausted)} ${ops.pool.exhausted === 1 ? 'time' : 'times'}, of the ${asked}.`), ' Whoever got none saw the page\'s own number. Add numbers, or shorten POOL_MINUTES.'] : [`A number was free each of the ${asked}.`]))))
  }

  if (ops.outbox !== null) out.push(el('section', {}, el('h2', {}, 'Conversions to ad platforms, all time'), parts('Conversions by state', [['Sent', ops.outbox.sent], ['Waiting to be sent', ops.outbox.pending], ['Held for a call result', ops.outbox.held], ['Not sent, with a reason', ops.outbox.skipped], ['Refused for good', ops.outbox.failed]])))
  return out
}

view('health', 'Health', async (box) => {
  // A server built as a library may not say how its own jobs run.
  const running = api('GET', '/ops').catch((error) => (error.message === 'No such route' ? null : Promise.reject(error)))
  const [policy, disputes, audit, ops] = await Promise.all([api('GET', '/policy'), api('GET', '/disputes'), api('GET', '/audit'), running])
  const { same, related, bridge, review } = policy.rules
  const states = ops?.outbox
  const quiet = ops?.feeds.filter((feed) => feed.quiet) ?? []
  const broken = ops?.jobs.filter((job) => job.state === 'failed' || job.state === 'stuck') ?? []
  // What needs a person, first and by name. Everything under it is there to say why.
  const needs = [
    !audit.sound && ['The record of decisions was altered.', `Entry ${audit.brokenAt} does not fit the one before it.`],
    policy.due && ['A rebuild is due.', `${policy.builtWith === null ? 'It is not recorded which policy the stored clusters were built with.' : policy.builtWith === 'mixed' ? 'More than one policy has written the stored clusters.' : `The stored clusters were built with policy ${short(policy.builtWith)}.`} Policy ${short(policy.hash)} runs now. Clusters stay as they were until someone with the service token posts to /rebuild.`],
    ...quiet.map((feed) => [`${NAMES[feed.name]} have gone quiet.`, feed.last === null ? 'None has ever been written down.' : `The last was written down ${lasted(ops.at - feed.last)} ago.`]),
    ...broken.map((job) => [`The job "${job.name}" ${job.state === 'stuck' ? 'never finished' : 'failed'}.`, job.error ?? '']),
    states?.failed > 0 && [`${amount(states.failed)} ${states.failed === 1 ? 'conversion was' : 'conversions were'} refused for good.`, 'They are listed by GET /conversions?state=failed and put back with POST /retry.'],
    ops?.undelivered.length > 0 && [`${amount(ops.undelivered.length)} ${ops.undelivered.length === 1 ? 'alert was' : 'alerts were'} not delivered.`, ops.alerts ? 'Each is tried again every five minutes.' : 'No webhook is set, so nobody has been told. Set ALERT_WEBHOOK.'],
    disputes.length > 0 && [`Systems disagree about ${amount(disputes.length)} ${disputes.length === 1 ? 'pair' : 'pairs'}.`, 'Find out which system is right, and stop the other from sending.'],
  ].filter(Boolean)
  box.append(el('section', {}, el('h3', {}, 'Health'), tiles(
    ['Needs someone', needs.length > 0 ? amount(needs.length) : 'Nothing', '', needs.length > 0 ? 'apart' : 'same'],
    ['Record', audit.sound ? 'Whole' : 'Altered', audit.head ? `${amount(audit.head.seq)} ${audit.head.seq === 1 ? 'decision' : 'decisions'}` : 'no decision yet', audit.sound ? '' : 'apart'],
    ['Policy', policy.due ? 'Rebuild due' : 'In force', short(policy.hash), policy.due ? 'apart' : ''],
    states && ['Waiting to be sent', amount(states.pending), `${amount(states.held)} held for a call result`],
    states && ['Sent', amount(states.sent), `${amount(states.skipped)} not sent, ${amount(states.failed)} refused`, states.failed > 0 ? 'apart' : ''],
    ops && ['Alerts', ops.alerts ? 'Webhook set' : 'No webhook', ops.undelivered.length > 0 ? `${amount(ops.undelivered.length)} not delivered` : '', ops.undelivered.length > 0 ? 'apart' : '']),
  needs.length > 0 ? el('ul', { class: 'needs' }, ...needs.map(([what, more]) => el('li', {}, el('b', {}, what), more ? ` ${more}` : ''))) : ''))
  if (ops) box.append(...workings(ops))

  // What one shared identifier of a kind does by itself, which is what its weight means.
  const kinds = Object.entries(policy.rules.kinds).sort(([x, a], [y, b]) => b.weight - a.weight || (x < y ? -1 : 1))
  const bands = [['At or above what joins', (w) => w >= same], ['At or above what relates', (w) => w >= related && w < same], ['Below both, adds to others', (w) => w > 0 && w < related]]
  const scale = (weight) => {
    const bar = meter(weight)
    for (const [at, name] of [[related, 'related'], [same, 'same'], [bridge, 'bridge']]) {
      const mark = el('i', { class: name })
      mark.style.left = `${at * 100}%`
      bar.append(mark)
    }
    bar.classList.add('scale')
    return bar
  }
  const rules = el('table', { class: 'rules' }, el('tr', {}, el('td', {}), group('Evidence when only two share it, just seen', 2), group('What weakens it', 3), el('td', { class: 'edge' })),
    el('tr', {}, th('Kind'), ...edge([th('Weight', 'num'), th(`related ${percent(related)}, joined ${percent(same)}, joins groups ${percent(bridge)}`)]), ...edge([th('Shared by 4', 'num'), th('Half-life', 'num'), th('Links nothing past', 'num')]), th('', 'edge')))
  for (const [name, holds] of bands) {
    const rows = kinds.filter(([, rule]) => holds(rule.weight))
    if (rows.length === 0) continue
    rules.append(el('tbody', {}, el('tr', { class: 'day' }, el('th', { scope: 'rowgroup', colspan: 7 }, name)), ...rows.map(([kind, rule]) => el('tr', {}, td('', kind), ...edge([td('num', rule.weight.toFixed(2)), td('bar', scale(rule.weight))]),
      ...edge([td('num', rule.cap < 4 ? el('span', { class: 'muted' }, 'nothing') : rule.dilution === 0 ? el('span', { class: 'muted' }, 'the same') : (rule.weight * 0.5 ** rule.dilution).toFixed(2)), td('num', rule.halfLife === 'none' ? el('span', { class: 'muted' }, 'none') : lasting(rule.halfLife)), td('num', `${amount(rule.cap)} subjects`)]),
      td('edge', rule.group ? el('span', { class: 'chip' }, `counts once with ${rule.group}`) : '', policy.changed.includes(kind) ? el('span', { class: 'chip' }, 'changed from the default') : '')))))
  }
  const only = kinds.filter(([, rule]) => rule.weight === 0).map(([kind]) => (policy.changed.includes(kind) ? `${kind} (changed from the default)` : kind))
  box.append(el('section', {}, el('h2', {}, 'What counts as the same person'), wide('Policy rules by kind', rules),
    el('p', { class: 'muted' }, `${only.length > 0 ? `Kept and linking nothing: ${only.join(', ')}. ` : ''}Clusters over ${amount(review)} subjects are flagged.`)))

  const record = el('section', {}, el('h2', {}, 'Record of decisions'))
  if (audit.head) {
    const hash = el('input', { readonly: '', value: audit.head.hash, size: 66, 'aria-label': 'Hash of the newest entry', on: { focus: () => hash.select() } })
    const copied = el('span', { class: 'muted', role: 'status' })
    const copy = el('button', { on: { click: async () => {
      try {
        await navigator.clipboard.writeText(`${audit.head.seq} ${audit.head.hash}`)
        copied.textContent = 'Copied, with its number.'
      } catch {
        // A page without permission, or not served securely, cannot copy: leave it selected for the keyboard.
        hash.focus()
        copied.textContent = 'Selected. Press Ctrl or Cmd and C.'
      }
    } } }, 'Copy')
    record.append(el('div', { class: 'row' }, el('label', { class: 'grow' }, `Entry ${audit.head.seq}`, hash), copy, copied),
      notes("Keep a copy somewhere the database's owners cannot write. Whoever can rewrite the whole record can make it whole again, but not with a hash you already hold."))
  } else record.append(el('p', {}, 'No decision has been recorded.'))
  box.append(record)

  const table = el('table', {}, el('tr', {}, th('One'), th('The other'), th('Contradictions, all time', 'num'), th('Last report'), th('By')))
  for (const { a, b, last, reversals } of disputes) table.append(el('tr', {}, td('who', open(a)), td('who', open(b)), td('num', reversals), td('', `${last.action === 'separate' ? 'kept apart' : last.action === 'join' ? 'joined' : 'allowed to join'}, ${when(last.at)}`), td('', author(last.by))))
  if (disputes.length > 0) box.append(el('section', {}, el('h2', {}, 'Pairs systems disagree about'), wide('Pairs systems disagree about', table),
    notes('Two subjects that systems have reported as one person and as two by turns, three times or more. A separation holds over a join, so the pair may have stayed apart throughout.')))
}, { every: 30_000 })
