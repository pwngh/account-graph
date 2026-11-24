// What runs, and what needs someone.
const short = (hash) => (hash === null ? unrecorded() : hash === 'mixed' ? 'More than one policy' : reviewDisplay.id(hash))
const lasting = (ms) => (ms === 'none' ? 'none' : ms >= 86400000 ? `${amount(Math.round(ms / 8640000) / 10)} days` : `${amount(Math.round(ms / 360000) / 10)} hours`)

const NAMES = { touches: 'Arrivals', calls: 'Calls', results: 'Call results', costs: 'Campaign costs' }
const JOB = { running: 'Running', stuck: 'Never finished', done: 'Succeeded', failed: 'Failed' }
const ago = (at, now) => reviewDisplay.time(at, now)

/** Puts a conversion back in line for the platform that refused it. */
async function again(job, button) {
  button.disabled = true
  try {
    const put = await api('POST', '/retry', { transactionId: job.transactionId, target: job.target })
    if (await load()) notice(put.length > 0 ? `${job.action} is back in line, to be sent with the next pass.` : `${job.action} was no longer refused. Nothing was changed.`)
  } catch (error) {
    button.disabled = false
    notice(error.message, true)
  }
}

/** Alerts that did not arrive, what feeds the graph, the jobs that run by themselves, and what waits to be sent. */
function workings(ops, refused) {
  const out = []
  if (ops.undelivered.length > 0) {
    out.push(el('section', {}, el('h2', {}, 'Alerts not delivered'),
      el('ul', {}, ...ops.undelivered.map((alert) => el('li', {}, alert.text, el('span', { class: 'reason' }, ago(alert.at, ops.at), alert.error ? ` · ${alert.error}` : ''))))))
  }

  const FEED = { touches: 'M2.5 13 13 8 2.5 3l2 5ZM4.5 8H8', calls: VIEW_ICONS.calls, results: 'M3 8.4 6.4 11.8 13 4.6', costs: 'M8 2.2v11.6M11 4.8c-.6-1-1.7-1.5-3-1.5-1.7 0-3 .9-3 2.3 0 3.2 6.200 1.600 6.200 4.8 0 1.400-1.400 2.3-3.2 2.3-1.5 0-2.700-.6-3.3-1.600' }
  const feeds = el('ul', { class: 'cards' }, ...ops.feeds.map((feed) => el('li', {}, tile(FEED[feed.name]), el('b', {}, NAMES[feed.name]),
    feed.quiet ? el('span', { class: 'chip apart' }, 'quiet') : feed.hours > 0 ? el('span', { class: 'chip same' }, 'heard from') : el('span', { class: 'meta' }, 'not watched'),
    el('span', { class: 'meta' }, 'Last written down ', ago(feed.last, ops.at), feed.hours > 0 ? ` · quiet after ${amount(feed.hours)} h` : ''))))

  const jobs = el('ul', { class: 'cards' }, ...ops.jobs.map((job) => el('li', {}, tile('M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.6h-2.6'), el('b', {}, job.name),
    el('span', { class: `chip ${job.state === 'done' ? 'same' : job.state === 'running' ? '' : 'apart'}` }, JOB[job.state]),
    el('span', { class: 'meta' }, 'Began ', ago(job.started, ops.at), ' · last success ', ago(job.succeeded, ops.at), ' · last failure ', job.failed === undefined ? 'none' : ago(job.failed, ops.at),
      job.error && job.state === 'failed' ? el('span', { class: 'reason apart' }, job.error) : '', ...job.open.slice(0, 3).map((began) => el('span', { class: 'reason' }, `A run that began ${when(began)} never finished.`))))))
  const runs = el('div', {}, el('section', {}, el('h2', {}, 'Feeds'), feeds),
    el('section', ops.jobs.length ? {} : { class: 'ops-empty' }, el('h2', {}, 'Jobs'),
      ops.jobs.length > 0 ? jobs : el('p', { class: 'muted' }, 'No jobs have run yet.')))
  const sends = el('div', {})
  if (ops.outbox !== null) sends.append(el('section', {}, el('h2', {}, 'Conversions to ad platforms, all time'), parts('Conversions by state', [['Sent', ops.outbox.sent], ['Waiting to be sent', ops.outbox.pending], ['Held for a call result', ops.outbox.held], ['Not sent, with a reason', ops.outbox.skipped], ['Refused for good', ops.outbox.failed]])))
  if (ops.pool) {
    const asked = `${amount(ops.pool.leased + ops.pool.exhausted)} ${ops.pool.leased + ops.pool.exhausted === 1 ? 'time' : 'times'} one was asked for since the server started, ${when(ops.pool.since)}`
    sends.append(el('section', {}, el('h2', {}, `Number pool, each number for ${amount(ops.pool.minutes)} minutes after the page last asked`), parts('Numbers', [['Shown to a visitor', ops.pool.held], ['Free', ops.pool.numbers - ops.pool.held]]),
      el('p', {}, ...(ops.pool.exhausted > 0 ? [el('b', { class: 'apart' }, `Every number was taken ${amount(ops.pool.exhausted)} ${ops.pool.exhausted === 1 ? 'time' : 'times'}, of the ${asked}.`), ' Whoever got none saw the page\'s own number. Add numbers, or shorten POOL_MINUTES.'] : [`A number was free each of the ${asked}.`]))))
  }
  out.push(el('div', { class: 'panel-grid ops-grid' }, runs, sends.hasChildNodes() ? sends : ''))
  if (refused.length > 0) out.push(el('section', {}, el('h2', {}, `Refused conversions, ${refused.length < ops.outbox.failed ? `newest ${amount(refused.length)} of ${amount(ops.outbox.failed)}` : amount(refused.length)}`),
    el('ul', { class: 'cards rows' }, ...refused.map((job) => el('li', {}, tile('M2.5 13 13 8 2.5 3l2 5ZM4.5 8H8', 'apart'), el('b', {}, job.action, ' ', el('span', { class: 'muted' }, job.value === undefined ? none() : `${money(job.value)} ${job.currency ?? ''}`)),
      el('button', { 'aria-label': `Send ${job.transactionId} to ${job.target} again`, on: { click: (event) => again(job, event.currentTarget) } }, 'Send again'),
      el('span', { class: 'flow' }, ago(job.at, ops.at), el('a', { class: 'who-chip', href: subjectHash(job.subject), title: job.subject }, badge(job.subject), reviewDisplay.idText(job.subject)), el('span', { class: 'sr-only' }, ' to '), el('i', { class: 'to', 'aria-hidden': 'true' }), el('span', { class: 'who-chip' }, sourced(job.target)), el('span', { class: 'meta' }, job.note || unrecorded()))))),
    notes('The platform’s answer says why it refused. Put that right first, or it will refuse again.')))
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
    policy.due && ['Rebuild due.', el('span', {},
      policy.builtWith === null ? 'Stored policy not recorded.' : policy.builtWith === 'mixed' ? 'Multiple policies wrote the stored clusters.' : el('span', {}, 'Stored policy: ', short(policy.builtWith), '.'),
      ' Current policy: ', short(policy.hash), '. Clusters stay unchanged until a service token is used to post to /rebuild.')],
    ...quiet.map((feed) => [`${NAMES[feed.name]} have gone quiet.`, feed.last === null ? 'Nothing recorded yet.' : el('span', {}, 'Last recorded ', ago(feed.last, ops.at), '.')]),
    ...broken.map((job) => [`${job.name}: ${job.state === 'stuck' ? 'never finished' : 'failed'}.`, job.error ?? '']),
    states?.failed > 0 && [`${amount(states.failed)} ${states.failed === 1 ? 'conversion was' : 'conversions were'} refused for good.`, 'Fix the refusal reason before retrying.'],
    ops?.undelivered.length > 0 && [`${amount(ops.undelivered.length)} ${ops.undelivered.length === 1 ? 'alert was' : 'alerts were'} not delivered.`, ops.alerts ? 'Each is tried again every five minutes.' : 'No webhook is set, so nobody has been told. Set ALERT_WEBHOOK.'],
    disputes.length > 0 && [`Systems disagree about ${amount(disputes.length)} ${disputes.length === 1 ? 'pair' : 'pairs'}.`, 'Find out which system is right, and stop the other from sending.'],
  ].filter(Boolean)
  box.append(el('section', {}, reviewDisplay.heading('Health'), tiles(
    ['Needs someone', needs.length > 0 ? amount(needs.length) : 'Nothing', '', needs.length > 0 ? 'apart' : 'same'],
    ['Record', audit.sound ? 'Whole' : 'Altered', audit.head ? `${amount(audit.head.seq)} ${audit.head.seq === 1 ? 'decision' : 'decisions'}` : 'no decision yet', audit.sound ? '' : 'apart'],
    ['Policy', policy.due ? 'Rebuild due' : 'In force', short(policy.hash), policy.due ? 'apart' : ''],
    states && ['Waiting to be sent', amount(states.pending), `${amount(states.held)} held for a call result`],
    states && ['Sent', amount(states.sent), `${amount(states.skipped)} not sent, ${amount(states.failed)} refused`, states.failed > 0 ? 'apart' : ''],
    ops && ['Alerts', ops.alerts ? 'Webhook set' : 'No webhook', ops.undelivered.length > 0 ? `${amount(ops.undelivered.length)} not delivered` : '', ops.undelivered.length > 0 ? 'apart' : '']),
  needs.length > 0 ? el('ul', { class: 'needs' }, ...needs.map(([what, more]) => el('li', {}, el('b', {}, what), more ? ' ' : '', more || ''))) : ''))
  if (ops) box.append(...workings(ops, states?.failed > 0 ? await api('GET', '/conversions?state=failed') : []))

  // What one shared identifier of a kind does by itself, which is what its weight means.
  const kinds = Object.entries(policy.rules.kinds).sort(([x, a], [y, b]) => b.weight - a.weight || (x < y ? -1 : 1))
  const bands = [['At or above what joins', (w) => w >= same], ['At or above what relates', (w) => w >= related && w < same], ['Below both, adds to others', (w) => w > 0 && w < related], ['Only confirms what the others relate']]
  const scale = (weight) => meter(weight, [[related, 'related'], [same, 'same'], [bridge, 'bridge']])
  const rules = el('table', { class: 'rules' }, el('tr', {}, el('td', {}), group('Evidence when only two share it, just seen', 2), group('What weakens it', 3), el('td', { class: 'edge' })),
    el('tr', {}, th('Kind'), ...edge([th('Weight', 'num'), th('Relative weight')]), ...edge([th('Shared by 4', 'num'), th('Half-life', 'num'), th('Links nothing past', 'num')]), th('Notes', 'edge')))
  for (const [name, holds] of bands) {
    const rows = kinds.filter(([, rule]) => (rule.corroborates ? !holds : holds?.(rule.weight)))
    if (rows.length === 0) continue
    rules.append(el('tbody', {}, el('tr', { class: 'day' }, el('th', { scope: 'rowgroup', colspan: 7 }, name)), ...rows.map(([kind, rule]) => el('tr', {}, td('', kind), ...edge([td('num', rule.weight.toFixed(2)), td('bar', scale(rule.weight))]),
      ...edge([td('num', rule.cap < 4 ? el('span', { class: 'muted' }, 'nothing') : rule.dilution === 0 ? el('span', { class: 'muted' }, 'the same') : (rule.weight * 0.5 ** rule.dilution).toFixed(2)), td('num', rule.halfLife === 'none' ? el('span', { class: 'muted' }, 'none') : lasting(rule.halfLife)), td('num', `${amount(rule.cap)} subjects`)]),
      td('edge', rule.group ? el('span', { class: 'chip' }, `counts once with ${rule.group}`) : '', policy.changed.includes(kind) ? el('span', { class: 'chip' }, 'changed from the default') : '')))))
  }
  const only = kinds.filter(([, rule]) => rule.weight === 0).map(([kind]) => (policy.changed.includes(kind) ? `${kind} (changed from the default)` : kind))
  box.append(el('section', {}, reviewDisplay.section('What counts as the same person',
    el('p', { class: 'meta' }, `Related ${percent(related)} · Joined ${percent(same)} · Joins groups ${percent(bridge)}`)),
  wide('Policy rules by kind', rules),
  el('p', { class: 'meta' }, `${only.length > 0 ? `Kept and linking nothing: ${only.join(', ')}. ` : ''}Clusters over ${amount(review)} subjects are flagged.`)))

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
      notes('This code is made from every decision so far. Change any of them and the code changes too.', 'So keep a copy somewhere the owners of this database cannot write. They could rewrite the record and make a new code, but not one that matches yours.'))
  } else record.append(el('p', {}, 'No decision has been recorded.'))
  box.append(record)

  const table = el('table', {}, el('tr', {}, th('One'), th('The other'), th('Contradictions, all time', 'num'), th('Last report'), th('By')))
  for (const { a, b, last, reversals } of disputes) {
    table.append(el('tr', {}, td('who', open(a)), td('who', open(b)), td('num', amount(reversals)),
      td('', reviewDisplay.chip(last.action === 'separate' ? 'Kept apart' : last.action === 'join' ? 'Joined' : 'Allowed to join', last.action === 'separate' ? 'apart' : 'same'),
        el('span', { class: 'reason' }, ago(last.at, Date.now()))), td('', author(last.by))))
  }
  if (disputes.length > 0) box.append(el('section', {}, el('h2', {}, 'Pairs systems disagree about'), wide('Pairs systems disagree about', table),
    notes('One of your systems says the two are one person, another says they are two, and they have gone back and forth three times or more.', 'Keeping apart wins over joining. So the pair may have stayed apart the whole time.')))
}, { every: 30_000 })
