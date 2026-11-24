// What runs, and what needs someone.
const short = (hash) => (hash === null ? unrecorded() : hash === 'mixed' ? 'Multiple policies' : reviewDisplay.id(hash))
const lasting = (ms) => (ms === 'none' ? 'none' : ms >= 86400000 ? `${amount(Math.round(ms / 8640000) / 10)} days` : `${amount(Math.round(ms / 360000) / 10)} hours`)

const NAMES = { touches: 'Visits', calls: 'Calls', results: 'Call results', costs: 'Campaign costs' }
const JOB = { running: 'Running', stuck: 'Stuck', done: 'OK', failed: 'Failed' }
const ago = (at, now) => reviewDisplay.time(at, now)

/** Puts a conversion back in line for the platform that refused it. */
async function again(job, button) {
  button.disabled = true
  try {
    const put = await api('POST', '/retry', { transactionId: job.transactionId, target: job.target })
    if (await load()) notice(put.length > 0 ? `${job.action} was queued.` : `${job.action} is no longer rejected.`)
  } catch (error) {
    button.disabled = false
    notice(error.message, true)
  }
}

/** Alerts that did not arrive, what feeds the graph, the jobs that run by themselves, and what waits to be sent. */
function workings(ops, refused) {
  const out = []
  if (ops.undelivered.length > 0) {
    out.push(el('section', {}, el('h2', {}, 'Undelivered alerts'),
      el('ul', {}, ...ops.undelivered.map((alert) => el('li', {}, alert.text, el('span', { class: 'reason' }, ago(alert.at, ops.at), alert.error ? ` · ${alert.error}` : ''))))))
  }

  const FEED = { touches: 'M2.5 13 13 8 2.5 3l2 5ZM4.5 8H8', calls: VIEW_ICONS.calls, results: 'M3 8.4 6.4 11.8 13 4.6', costs: 'M8 2.2v11.6M11 4.8c-.6-1-1.7-1.5-3-1.5-1.7 0-3 .9-3 2.3 0 3.2 6.200 1.600 6.200 4.8 0 1.400-1.400 2.3-3.2 2.3-1.5 0-2.700-.6-3.3-1.600' }
  const feeds = el('ul', { class: 'cards' }, ...ops.feeds.map((feed) => el('li', {}, tile(FEED[feed.name]), el('b', {}, NAMES[feed.name]),
    feed.quiet ? el('span', { class: 'chip apart' }, 'Stale') : feed.hours > 0 ? el('span', { class: 'chip same' }, 'OK') : el('span', { class: 'meta' }, 'Not monitored'),
    el('span', { class: 'meta' }, 'Last record ', ago(feed.last, ops.at), feed.hours > 0 ? ` · limit ${amount(feed.hours)} h` : ''))))

  const jobs = el('ul', { class: 'cards' }, ...ops.jobs.map((job) => el('li', {}, tile('M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.6h-2.6'), el('b', {}, job.name),
    el('span', { class: `chip ${job.state === 'done' ? 'same' : job.state === 'running' ? '' : 'apart'}` }, JOB[job.state]),
    el('span', { class: 'meta' }, 'Started ', ago(job.started, ops.at), ' · succeeded ', ago(job.succeeded, ops.at), ...(job.failed === undefined ? [] : [' · failed ', ago(job.failed, ops.at)]),
      job.error && job.state === 'failed' ? el('span', { class: 'reason apart' }, job.error) : '', ...job.open.slice(0, 3).map((began) => el('span', { class: 'reason' }, `Unfinished run: ${when(began)}`))))))
  const runs = el('div', {}, el('section', {}, el('h2', {}, term('Feeds', 'feeds')), feeds),
    el('section', ops.jobs.length ? {} : { class: 'ops-empty' }, el('h2', {}, 'Jobs'),
      ops.jobs.length > 0 ? jobs : el('p', { class: 'muted' }, 'No runs')))
  const sends = el('div', {})
  if (ops.outbox !== null) sends.append(el('section', {}, el('h2', {}, term('Conversions', 'conversions')), parts('Conversions', [['Sent', ops.outbox.sent], ['Queued', ops.outbox.pending], ['Held', ops.outbox.held], ['Skipped', ops.outbox.skipped], ['Rejected', ops.outbox.failed]])))
  if (ops.pool) {
    sends.append(el('section', {}, el('h2', {}, term('Tracking numbers', 'pool', `Each stays assigned for ${amount(ops.pool.minutes)} minutes after the last page request.`)), parts('Tracking numbers', [['In use', ops.pool.held], ['Available', ops.pool.numbers - ops.pool.held]]),
      el('p', { class: 'meta' }, `${amount(ops.pool.leased + ops.pool.exhausted)} requests since ${when(ops.pool.since)}${ops.pool.exhausted > 0 ? ` · ${amount(ops.pool.exhausted)} without an available number. Add numbers or shorten POOL_MINUTES.` : ''}`)))
  }
  out.push(el('div', { class: 'panel-grid ops-grid' }, runs, sends.hasChildNodes() ? sends : ''))
  if (refused.length > 0) out.push(el('section', {}, el('h2', {}, term('Rejected conversions', 'rejected'), el('span', { class: 'count' }, refused.length < ops.outbox.failed ? `${amount(refused.length)} of ${amount(ops.outbox.failed)}` : amount(refused.length))),
    el('ul', { class: 'cards rows' }, ...refused.map((job) => el('li', {}, tile('M2.5 13 13 8 2.5 3l2 5ZM4.5 8H8', 'apart'), el('b', {}, job.action, ' ', el('span', { class: 'muted' }, job.value === undefined ? none() : `${money(job.value)} ${job.currency ?? ''}`)),
      el('button', { 'aria-label': `Retry ${job.transactionId} for ${job.target}`, on: { click: (event) => again(job, event.currentTarget) } }, 'Retry'),
      el('span', { class: 'flow' }, ago(job.at, ops.at), el('a', { class: 'who-chip', href: subjectHash(job.subject), title: job.subject }, badge(job.subject), reviewDisplay.idText(job.subject)), el('span', { class: 'sr-only' }, ' to '), el('i', { class: 'to', 'aria-hidden': 'true' }), el('span', { class: 'who-chip' }, sourced(job.target)), el('span', { class: 'meta' }, job.note || unrecorded())))))))
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
    !audit.sound && ['Audit log altered.', `Verification failed at entry ${audit.brokenAt}.`],
    policy.due && ['Rebuild required.', el('span', {}, 'Groups were built with ', policy.builtWith === null ? 'an unknown policy' : policy.builtWith === 'mixed' ? 'multiple policies' : short(policy.builtWith), '. Current policy: ', short(policy.hash), '. Run POST /rebuild with a service token.')],
    ...quiet.map((feed) => [`${NAMES[feed.name]} feed is stale.`, feed.last === null ? 'No records.' : el('span', {}, 'Last record ', ago(feed.last, ops.at), '.')]),
    ...broken.map((job) => [`${job.name}: ${job.state === 'stuck' ? 'stuck' : 'failed'}.`, job.error ?? '']),
    states?.failed > 0 && [`${amount(states.failed)} rejected ${states.failed === 1 ? 'conversion' : 'conversions'}`, ''],
    ops?.undelivered.length > 0 && [`${amount(ops.undelivered.length)} undelivered ${ops.undelivered.length === 1 ? 'alert' : 'alerts'}.`, ops.alerts ? 'Retried every 5 minutes.' : 'Set ALERT_WEBHOOK.'],
    disputes.length > 0 && [`${amount(disputes.length)} conflicting ${disputes.length === 1 ? 'decision' : 'decisions'}`, ''],
  ].filter(Boolean)
  box.append(el('section', {}, reviewDisplay.heading('Health'), tiles(
    [term('Issues', 'issues'), amount(needs.length), '', needs.length > 0 ? 'apart' : 'same'],
    [term('Audit log', 'record'), audit.sound ? 'Verified' : 'Altered', `${amount(audit.head?.seq ?? 0)} ${audit.head?.seq === 1 ? 'entry' : 'entries'}`, audit.sound ? '' : 'apart'],
    [term('Policy', 'policy'), policy.due ? 'Rebuild required' : 'Active', short(policy.hash), policy.due ? 'apart' : ''],
    states && [term('Queued', 'queued'), amount(states.pending), `${amount(states.held)} held`],
    states && [term('Sent', 'sent'), amount(states.sent), `${amount(states.skipped)} skipped · ${amount(states.failed)} rejected`],
    ops && [term('Alerts', 'alerts'), ops.alerts ? 'On' : 'Off', ops.undelivered.length > 0 ? `${amount(ops.undelivered.length)} undelivered` : '', ops.undelivered.length > 0 ? 'apart' : '']),
  needs.length > 0 ? el('ul', { class: 'needs' }, ...needs.map(([what, more]) => el('li', {}, el('b', {}, what), more ? ' ' : '', more || ''))) : ''))
  if (ops) box.append(...workings(ops, states?.failed > 0 ? await api('GET', '/conversions?state=failed') : []))

  // What one shared identifier of a kind does by itself, which is what its weight means.
  const kinds = Object.entries(policy.rules.kinds).sort(([x, a], [y, b]) => b.weight - a.weight || (x < y ? -1 : 1))
  const bands = [['Meets join threshold', (w) => w >= same], ['Meets related threshold', (w) => w >= related && w < same], ['Below thresholds', (w) => w > 0 && w < related], ['Corroborating only']]
  const scale = (weight) => meter(weight, [[related, 'related'], [same, 'same'], [bridge, 'bridge']])
  const rules = el('table', { class: 'rules' }, el('tr', {}, th('Identifier'), ...edge([th('Weight', 'num'), el('td', {})]), ...edge([th('Shared by 4', 'num'), th('Half-life', 'num'), th('Limit', 'num')]), th('Notes', 'edge')))
  for (const [name, holds] of bands) {
    const rows = kinds.filter(([, rule]) => (rule.corroborates ? !holds : holds?.(rule.weight)))
    if (rows.length === 0) continue
    rules.append(el('tbody', {}, el('tr', { class: 'day' }, el('th', { scope: 'rowgroup', colspan: 7 }, name)), ...rows.map(([kind, rule]) => el('tr', {}, td('', kind), ...edge([td('num', rule.weight.toFixed(2)), td('bar', scale(rule.weight))]),
      ...edge([td('num', rule.cap < 4 ? none() : rule.dilution === 0 ? rule.weight.toFixed(2) : (rule.weight * 0.5 ** rule.dilution).toFixed(2)), td('num', rule.halfLife === 'none' ? none() : lasting(rule.halfLife)), td('num', `${amount(rule.cap)} IDs`)]),
      td('edge', rule.group ? el('span', { class: 'chip' }, `${rule.group} group`) : '', policy.changed.includes(kind) ? el('span', { class: 'chip' }, 'Modified') : '')))))
  }
  const only = kinds.filter(([, rule]) => rule.weight === 0).map(([kind]) => (policy.changed.includes(kind) ? `${kind} (modified)` : kind))
  box.append(el('section', {}, reviewDisplay.section(term('Matching rules', 'rules'),
    el('p', { class: 'meta' }, `Related ≥ ${percent(related)} · Join ≥ ${percent(same)} · Join groups ≥ ${percent(bridge)} · Review over ${amount(review)} IDs`)),
  wide('Matching rules', rules),
  only.length > 0 ? el('p', { class: 'meta' }, `Not used for matching: ${only.join(', ')}`) : ''))

  const record = el('section', {}, el('h2', {}, term('Audit log', 'chain')))
  if (audit.head) {
    const hash = el('input', { readonly: '', value: audit.head.hash, size: 66, 'aria-label': 'Verification hash', on: { focus: () => hash.select() } })
    const copied = el('span', { class: 'muted', role: 'status' })
    const copy = el('button', { on: { click: async () => {
      try {
        await navigator.clipboard.writeText(`${audit.head.seq} ${audit.head.hash}`)
        copied.textContent = 'Copied'
      } catch {
        // A page without permission, or not served securely, cannot copy: leave it selected for the keyboard.
        hash.focus()
        copied.textContent = 'Press Ctrl+C or ⌘C to copy'
      }
    } } }, 'Copy')
    record.append(el('div', { class: 'row' }, el('label', { class: 'grow' }, `Entry ${audit.head.seq}`, hash), copy, copied))
  } else record.append(el('p', {}, 'No entries'))
  box.append(record)

  const table = el('table', {}, el('tr', {}, th('ID'), th('ID'), th('Reversals', 'num'), th('Last decision'), th('Source')))
  for (const { a, b, last, reversals } of disputes) {
    table.append(el('tr', {}, td('who', open(a)), td('who', open(b)), td('num', amount(reversals)),
      td('', reviewDisplay.chip(last.action === 'separate' ? 'Separated' : last.action === 'join' ? 'Joined' : 'Separation removed', last.action === 'separate' ? 'apart' : 'same'),
        el('span', { class: 'reason' }, ago(last.at, Date.now()))), td('', author(last.by))))
  }
  if (disputes.length > 0) box.append(el('section', {}, el('h2', {}, term('Conflicting decisions', 'conflicts')), wide('Conflicting decisions', table)))
}, { every: 30_000 })
