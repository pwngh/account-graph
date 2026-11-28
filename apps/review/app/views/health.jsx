import { useEffect, useState } from 'react'
import { Form, Link } from 'react-router'
import { Author, Badge, Meter, Named, PageHead, Parts, Subject, Tiles, Time } from './shared'
import { Sourced, Tile } from './marks'
import { amount, idText, percent, subjectHash } from './report-words'
import { Term } from './terms'

const NAMES = { touches: 'Visits', calls: 'Calls', results: 'Call results', costs: 'Campaign costs' }
const FEED = { touches: 'visit', calls: 'call', results: 'result', costs: 'value' }
const JOB = { running: 'Running', stuck: 'Stuck', done: 'OK', failed: 'Failed' }
const lasting = ms => ms >= 86400000 ? amount(Math.round(ms / 8640000) / 10) + ' days' : amount(Math.round(ms / 360000) / 10) + ' hours'
const none = <span className="muted">—</span>

// Copying needs a script. Without one the hash is on the page to select.
function CopyHash({ head }) {
  const [enhanced, setEnhanced] = useState(false)
  const [said, setSaid] = useState('')
  useEffect(() => setEnhanced(true), [])
  if (!enhanced) return null
  return <><button type="button" onClick={async () => {
    try {
      await navigator.clipboard.writeText(head.seq + ' ' + head.hash)
      setSaid('Copied')
    } catch {
      // A page without permission, or not served securely, cannot copy.
      setSaid('Select the hash and press Ctrl+C or ⌘C to copy')
    }
  }}>Copy</button><span className="muted" role="status">{said}</span></>
}

/** What runs, and what needs someone. */
export function Health({ data, Detail }) {
  const { policy, disputes, audit, ops, refused, cards, at } = data
  const [enhanced, setEnhanced] = useState(false)
  useEffect(() => setEnhanced(true), [])
  const { same, related, bridge, review } = policy.rules
  const states = ops?.outbox
  const quiet = ops?.feeds.filter(feed => feed.quiet) ?? []
  const broken = ops?.jobs.filter(job => job.state === 'failed' || job.state === 'stuck') ?? []
  const undelivered = ops?.undelivered ?? []
  // What needs a person, first and by name. Everything under it is there to say why.
  const needs = [
    !audit.sound && ['Audit log altered.', 'Verification failed at entry ' + audit.brokenAt + '.'],
    ops?.paused && ['Sends to ad platforms are paused.', <>{ops.paused.reason}. Since <Time at={ops.paused.at} now={at}/>. Run account-graph sends resume once the cause is fixed.</>],
    policy.warning && [policy.warning, ''],
    ...quiet.map(feed => [NAMES[feed.name] + ' feed is stale.', feed.last === null ? 'No records.' : <>Last record <Time at={feed.last} now={at}/>.</>]),
    ...broken.map(job => [job.name + ': ' + (job.state === 'stuck' ? 'stuck' : 'failed') + '.', job.error ?? '']),
    states?.failed > 0 && [amount(states.failed) + ' rejected ' + (states.failed === 1 ? 'conversion' : 'conversions'), ''],
    undelivered.length > 0 && [amount(undelivered.length) + ' undelivered ' + (undelivered.length === 1 ? 'alert' : 'alerts') + '.', ops.alerts ? 'Retried every 5 minutes.' : 'Set ALERT_WEBHOOK.'],
    disputes.length > 0 && [amount(disputes.length) + ' conflicting ' + (disputes.length === 1 ? 'decision' : 'decisions'), ''],
  ].filter(Boolean)
  // What one shared identifier of a kind does by itself, which is what its weight means.
  const kinds = Object.entries(policy.rules.kinds).sort(([x, a], [y, b]) => b.weight - a.weight || (x < y ? -1 : 1))
  const bands = [['Meets join threshold', w => w >= same], ['Meets related threshold', w => w >= related && w < same], ['Below thresholds', w => w > 0 && w < related], ['Related only', undefined, 'relates'], ['Corroborating only', undefined, 'corroborates']]
  const unused = kinds.filter(([, rule]) => rule.weight === 0).map(([kind]) => policy.changed.includes(kind) ? kind + ' (modified)' : kind)
  return <><section><PageHead view="health" title="Health"/><Tiles items={[
    [['Issues', 'issues'], amount(needs.length), '', needs.length > 0 ? 'apart' : 'same'],
    [['Audit log', 'record'], audit.sound ? 'Verified' : 'Altered', amount(audit.head?.seq ?? 0) + (audit.head?.seq === 1 ? ' entry' : ' entries'), audit.sound ? '' : 'apart'],
    [['Policy', 'policy'], policy.due ? 'Rebuild required' : 'Active', policy.hash === null ? 'No data' : policy.hash === 'mixed' ? 'Multiple policies' : <span title={policy.hash}>{idText(policy.hash)}</span>, policy.due ? 'apart' : ''],
    states && [['Queued', 'queued'], amount(states.pending), amount(states.held) + ' held'],
    states && [['Sent', 'sent'], amount(states.sent), amount(states.skipped) + ' skipped · ' + amount(states.failed) + ' rejected'],
    ops && [['Alerts', 'alerts'], ops.alerts ? 'On' : 'Off', undelivered.length > 0 ? amount(undelivered.length) + ' undelivered' : '', undelivered.length > 0 ? 'apart' : ''],
  ]}/>{needs.length > 0 && <ul className="needs">{needs.map(([what, more], i) => <li key={i} role={what.startsWith('Sends to ad platforms') ? 'alert' : undefined}><b>{what}</b>{more && ' '}{more}</li>)}</ul>}</section>
  {undelivered.length > 0 && <section><h2>Undelivered alerts</h2><ul>{undelivered.map((alert, i) => <li key={i}>{alert.text}<span className="reason"><Time at={alert.at} now={at}/>{alert.error && ' · ' + alert.error}</span></li>)}</ul></section>}
  {ops && <div className="panel-grid ops-grid"><div><section><h2><Term id="feeds"/></h2><ul className="cards">{ops.feeds.map((feed, i) => <li key={feed.name}><Tile kind={FEED[feed.name] ?? 'result'}/><b>{NAMES[feed.name] ?? feed.name}</b>
      <span className="state">{feed.quiet ? <span className="chip apart">Stale</span> : feed.hours > 0 ? <span className="chip same">OK</span> : <span className="meta">Not monitored</span>}<Detail card={cards[data.feeds[i]]} label={(NAMES[feed.name] ?? feed.name) + ', ' + (feed.quiet ? 'stale' : feed.hours > 0 ? 'OK' : 'not monitored')}/></span>
      <span className="meta">Last record <Time at={feed.last ?? undefined} now={at}/>{feed.hours > 0 && ' · limit ' + amount(feed.hours) + ' h'}</span></li>)}</ul></section>
    <section className={ops.jobs.length ? undefined : 'ops-empty'}><h2>Jobs</h2>{ops.jobs.length > 0 ? <ul className="cards">{ops.jobs.map(job => <li key={job.name}><Tile kind="job"/><b>{job.name}</b><span className={'chip ' + (job.state === 'done' ? 'same' : job.state === 'running' ? '' : 'apart')}>{JOB[job.state]}</span>
      <span className="meta">Started <Time at={job.started ?? undefined} now={at}/> · succeeded <Time at={job.succeeded ?? undefined} now={at}/>{job.failed !== undefined && <> · failed <Time at={job.failed} now={at}/></>}{job.error && job.state === 'failed' && <span className="reason apart">{job.error}</span>}{job.open.slice(0, 3).map(began => <span className="reason" key={began}>Unfinished run: <Time at={began} short/></span>)}</span></li>)}</ul> : <p className="muted">No runs</p>}</section></div>
    {(states || ops.pool) && <div>{states && <section><h2><Term id="conversions"/></h2><Parts label="Conversions" list={[['Sent', states.sent], ['Queued', states.pending], ['Held', states.held], ['Skipped', states.skipped], ['Rejected', states.failed]]}/></section>}
      {ops.pool && <section><h2><Term id="pool" more={'Each stays assigned for ' + amount(ops.pool.minutes) + ' minutes after the last page request.'}/></h2><Parts label="Tracking numbers" list={[['In use', ops.pool.held], ['Available', ops.pool.numbers - ops.pool.held]]}/><p className="meta">{amount(ops.pool.leased + ops.pool.exhausted)} requests since <Time at={ops.pool.since} short/>{ops.pool.exhausted > 0 && ' · ' + amount(ops.pool.exhausted) + ' without an available number. Add numbers or shorten POOL_MINUTES.'}</p></section>}</div>}</div>}
  {refused.length > 0 && <section><h2><Term id="rejected"/><span className="count">{refused.length < states.failed ? amount(refused.length) + ' of ' + amount(states.failed) : amount(refused.length)}</span></h2><ul className="cards rows">{refused.map(job => <li key={job.transactionId + '/' + job.target}><Tile kind="send" tone="apart"/><b>{job.action} <span className="muted">{job.value === undefined ? '—' : amount(job.value) + ' ' + (job.currency ?? '')}</span></b>
    <Form method="post" action="/health" preventScrollReset>{enhanced && <input type="hidden" name="_enhanced" value="1"/>}<input type="hidden" name="intent" value="retry"/><input type="hidden" name="transactionId" value={job.transactionId}/><input type="hidden" name="target" value={job.target}/><button aria-label={'Retry ' + job.transactionId + ' for ' + job.target}>Retry</button></Form>
    <span className="flow"><Time at={job.at} now={at}/><Link className="who-chip" to={subjectHash(job.subject)} title={job.subject}><Badge id={job.subject}/><Named id={job.subject}/></Link><span className="sr-only"> to </span><i className="to" aria-hidden="true"/><span className="who-chip"><Sourced name={job.target}/></span><span className="meta">{job.note || 'No data'}</span></span></li>)}</ul></section>}
  <section><div className="section-head"><h2><Term id="rules"/></h2><p className="meta">Related ≥ {percent(related)} · Join ≥ {percent(same)} · Join groups ≥ {percent(bridge)} · Review over {amount(review)} IDs</p></div>
    <div className="wide" tabIndex="0" role="region" aria-label="Matching rules"><table className="rules"><thead><tr><th scope="col">Identifier</th><th scope="col" className="num edge">Weight</th><td/><th scope="col" className="num edge">Shared by 4</th><th scope="col" className="num">Half-life</th><th scope="col" className="num">Limit</th><th scope="col" className="edge">Notes</th></tr></thead>
    {bands.map(([name, holds, only]) => {
      const rows = kinds.filter(([, rule]) => only ? rule[only] : !rule.corroborates && !rule.relates && holds(rule.weight))
      return rows.length > 0 && <tbody key={name}><tr className="day"><th scope="rowgroup" colSpan="7">{name}</th></tr>{rows.map(([kind, rule]) => <tr key={kind}><td>{kind}</td><td className="num edge">{rule.weight.toFixed(2)}</td><td className="bar"><Meter share={rule.weight} marks={[[related, 'related'], [same, 'same'], [bridge, 'bridge']]}/></td>
        <td className="num edge">{rule.cap < 4 ? none : rule.dilution === 0 ? rule.weight.toFixed(2) : (rule.weight * 0.5 ** rule.dilution).toFixed(2)}</td><td className="num">{rule.halfLife === 'none' ? none : lasting(rule.halfLife)}</td><td className="num">{amount(rule.cap)} IDs</td>
        <td className="edge">{rule.group && <span className="chip">{rule.group} group</span>}{policy.changed.includes(kind) && <span className="chip">Modified</span>}</td></tr>)}</tbody>
    })}</table></div>{unused.length > 0 && <p className="meta">Not used for matching: {unused.join(', ')}</p>}</section>
  <section><h2><Term id="chain">Audit log</Term></h2>{audit.head ? <div className="row"><label className="grow">Entry {audit.head.seq}<input readOnly value={audit.head.hash} size="66" aria-label="Verification hash"/></label><CopyHash head={audit.head}/></div> : <p className="muted">No entries</p>}</section>
  {disputes.length > 0 && <section><h2><Term id="conflicts"/></h2><div className="wide" tabIndex="0" role="region" aria-label="Conflicting decisions"><table><thead><tr><th scope="col">ID</th><th scope="col">ID</th><th scope="col" className="num">Reversals</th><th scope="col">Last decision</th><th scope="col">Source</th></tr></thead><tbody>{disputes.map(({ a, b, last, reversals }) => <tr key={a + '/' + b}><td className="who"><Subject id={a}/></td><td className="who"><Subject id={b}/></td><td className="num">{amount(reversals)}</td>
    <td><span className={'chip ' + (last.action === 'separate' ? 'apart' : 'same')}>{last.action === 'separate' ? 'Separated' : last.action === 'join' ? 'Joined' : 'Separation removed'}</span><span className="reason"><Time at={last.at} now={at}/></span></td><td><Author by={last.by}/></td></tr>)}</tbody></table></div></section>}</>
}
