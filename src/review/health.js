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
      el('p', { class: 'banner', role: 'alert' }, el('b', {}, `${amount(ops.undelivered.length)} not delivered. `), ops.alerts ? 'Each is tried again every five minutes, and stays here until it arrives.' : 'No webhook is set, so nobody has been told. Set ALERT_WEBHOOK.'),
      el('ul', {}, ...ops.undelivered.map((alert) => el('li', {}, alert.text, el('span', { class: 'reason' }, `${when(alert.at)}${alert.error ? `. ${alert.error}` : ''}`))))))
  } else if (!ops.alerts) out.push(el('section', {}, el('h2', {}, 'Alerts'), el('p', {}, 'No webhook is set, so what goes wrong is shown here and nobody is told.')))

  const feeds = el('table', {}, el('tr', {}, th('Feed'), th('Last written down'), th('Quiet after'), th('State')),
    ...ops.feeds.map((feed) => el('tr', {}, td('', NAMES[feed.name]), td('', ago(feed.last, ops.at)), td('', feed.hours > 0 ? `${amount(feed.hours)} h` : 'not watched'),
      td('', feed.quiet ? el('span', { class: 'chip apart' }, 'quiet') : feed.hours > 0 ? el('span', { class: 'chip same' }, 'heard from') : ''))))
  out.push(el('section', {}, el('h2', {}, 'Feeds'), wide('Feeds', feeds)))

  const jobs = el('table', {}, el('tr', {}, th('Job'), th('State'), th('Began'), th('Last success'), th('Last failure'), th('Why')),
    ...ops.jobs.map((job) => el('tr', {}, td('', job.name), td('', el('span', { class: `chip ${job.state === 'done' ? 'same' : job.state === 'running' ? '' : 'apart'}` }, JOB[job.state])), td('', ago(job.started, ops.at)),
      td('', ago(job.succeeded, ops.at)), td('', job.failed === undefined ? el('span', { class: 'muted' }, 'none') : ago(job.failed, ops.at)),
      td('who', job.error && job.state === 'failed' ? job.error : '', job.unfinished === undefined ? '' : el('span', { class: 'reason' }, `A run that began ${when(job.unfinished)} never finished.`)))))
  out.push(el('section', {}, el('h2', {}, 'Jobs'), ops.jobs.length > 0 ? wide('Jobs', jobs) : el('p', {}, 'None has run yet.')))

  const states = [['held', 'waiting for a call result'], ['pending', 'waiting to be sent'], ['sent', 'sent'], ['skipped', 'not sent, with a reason'], ['failed', 'refused for good']]
  out.push(el('section', {}, el('h2', {}, 'Conversions to ad platforms, all time'), ops.outbox === null ? el('p', {}, 'No ad platform is set up, so nothing is sent.')
    : wide('Conversions', el('table', {}, el('tr', {}, th('State'), th('Jobs', 'num'), th('What it means')), ...states.map(([state, meaning]) => el('tr', {}, td('', state), td('num', amount(ops.outbox[state])), td(state === 'failed' && ops.outbox.failed > 0 ? 'apart' : 'muted', meaning)))))))
  return out
}

view('health', 'Health', async (box) => {
  // A server built as a library may not say how its own jobs run.
  const running = api('GET', '/ops').catch((error) => (error.message === 'No such route' ? null : Promise.reject(error)))
  const [policy, disputes, audit, ops] = await Promise.all([api('GET', '/policy'), api('GET', '/disputes'), api('GET', '/audit'), running])
  box.append(el('section', {}, el('h3', {}, 'Health'), el('p', { class: 'muted' }, 'What this server runs, as it stands now.')))
  if (ops) box.append(...workings(ops))

  const rules = el('table', {}, el('tr', {}, th('Kind'), th('Weight', 'num'), th('Dilution', 'num'), th('Cap, subjects', 'num'), th('Half-life', 'num'), th('Group'), th('')))
  const kinds = Object.entries(policy.rules.kinds).sort(([x, a], [y, b]) => b.weight - a.weight || (x < y ? -1 : 1))
  for (const [kind, rule] of kinds) {
    rules.append(el('tr', {}, td('', kind), td('num', rule.weight.toFixed(2)), td('num', rule.dilution), td('num', amount(rule.cap)), td('num', lasting(rule.halfLife)), td('', rule.group ?? ''),
      td('', policy.changed.includes(kind) ? el('span', { class: 'chip' }, 'changed from the default') : rule.weight === 0 ? el('span', { class: 'muted' }, 'a note, links nothing') : '')))
  }
  const { same, related, bridge, review } = policy.rules
  const section = el('section', {}, el('h2', {}, 'Policy'))
  if (policy.due) section.append(el('p', { class: 'banner', role: 'alert' }, el('b', {}, 'A rebuild is due. '),
    policy.builtWith === null ? 'It is not recorded which policy the stored clusters were built with. ' : policy.builtWith === 'mixed' ? 'More than one policy has written the stored clusters. ' : `The stored clusters were built with policy ${short(policy.builtWith)}. `,
    `Policy ${short(policy.hash)} runs now. Clusters stay as they were until someone with the service token posts to /rebuild.`))
  section.append(
    el('p', {}, `Running policy ${short(policy.hash)}. Stored clusters built with ${short(policy.builtWith)}.${policy.due ? '' : ' They agree, or there are none yet.'}`),
    el('p', { class: 'muted' }, `Joined at ${percent(same)}, related at ${percent(related)}, one link alone joins two groups at ${percent(bridge)}. Clusters over ${amount(review)} subjects are flagged.`),
    wide('Policy rules by kind', rules))
  box.append(section)

  const record = el('section', {}, el('h2', {}, 'Record of decisions'))
  if (!audit.sound) record.append(el('p', { class: 'banner', role: 'alert' }, el('b', {}, 'The record was altered. '), `Entry ${audit.brokenAt} does not fit the one before it.`))
  if (audit.head) {
    const hash = el('input', { readonly: '', value: audit.head.hash, size: 66, 'aria-label': 'Newest hash', on: { focus: () => hash.select() } })
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
    record.append(el('p', {}, `${audit.sound ? 'Whole, checked just now' : 'Not whole'}. Newest entry ${audit.head.seq}.`), el('div', { class: 'row' }, el('label', { class: 'grow' }, 'Newest hash', hash), copy, copied),
      el('p', { class: 'muted' }, "Keep a copy somewhere the database's owners cannot write. Whoever can rewrite the whole record can make it whole again, but not with a hash you already hold."))
  } else record.append(el('p', {}, 'No decision has been recorded.'))
  box.append(record)

  const table = el('table', {}, el('tr', {}, th('One'), th('The other'), th('Contradictions, all time', 'num'), th('Last report'), th('By')))
  for (const { a, b, last, reversals } of disputes) table.append(el('tr', {}, td('who', open(a)), td('who', open(b)), td('num', reversals), td('', `${last.action === 'separate' ? 'kept apart' : last.action === 'join' ? 'joined' : 'allowed to join'}, ${when(last.at)}`), td('', author(last.by))))
  box.append(el('section', {}, el('h2', {}, 'Pairs systems disagree about'), el('p', { class: 'muted' }, 'Two subjects that systems have reported as one person and as two by turns, three times or more. A separation holds over a join, so the pair may have stayed apart throughout. Find out which system is right, and stop the other from sending.'),
    disputes.length > 0 ? wide('Pairs systems disagree about', table) : el('p', {}, 'None.')))
}, { every: 30_000 })
