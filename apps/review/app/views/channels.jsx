import './reports.css'
import { Form, Link } from 'react-router'
import { Compare, Meter, PageHead, PeriodForm, Tiles } from './shared'
import { Change } from './call-panels'
import { Sourced } from './marks'
import { amount, dayWords, percent } from './report-words'

/** A dimension in words. Which side it is from matters as much as its name. */
const dimensionName = by => by === 'hour' ? 'Hour' : by === 'weekday' ? 'Weekday' : by.startsWith('touch.') ? 'Visit: ' + by.slice(6).replaceAll('_', ' ') : 'Outcome: ' + by.slice(8).replaceAll('_', ' ')
const GROUPS = { answer: 'Call result', talk: 'Talk time', language: 'Language', returned: 'Callback' }
const none = <span className="muted">—</span>
const unknown = <span className="muted">No data</span>
const tally = n => n > 0 ? amount(n) : <span className="muted">0</span>
const many = (n, one, more) => amount(n) + ' ' + (n === 1 ? one : more)
/** A campaign nobody reported a cost for may have cost nothing or anything. Only a number somebody sent is shown as one. */
const unpriced = row => row.costDays === 0 && row.cost === 0 && row.clicks === 0

/** Rows ranked by one measure, each with a bar of its share behind its name. The measure is in the address, so the tabs are links. */
function Ranked({ label, rows, named, measures, rank, address }) {
  const [name, value, words, shares = true] = measures.find(([each]) => each === rank) ?? measures[0]
  const known = rows.filter(row => value(row) !== null && value(row) > 0).sort((x, y) => value(y) - value(x))
  const without = rows.filter(row => value(row) === null).length
  const top = Math.max(...known.map(value), 1)
  const whole = known.reduce((sum, row) => sum + value(row), 0)
  return <div className="ranked-box"><nav className="segments" aria-label={label + ', by'}>{measures.map(([each]) => <Link key={each} aria-current={each === name ? 'true' : undefined} to={address({ rank: each })} preventScrollReset>{each}</Link>)}</nav>
    <ol className="ranked">{known.slice(0, 8).map((row, i) => <li key={i}><svg className="ranked-bar" width="100%" height="100%" aria-hidden="true" focusable="false"><rect width={100 * value(row) / top + '%'} height="100%" rx="8"/></svg><span className="ranked-name">{named(row)}</span><span className="ranked-share">{!shares ? '' : value(row) / whole < 0.005 ? '<1%' : percent(value(row) / whole)}</span><b>{words(value(row))}</b></li>)}{known.length === 0 && <li className="muted">None.</li>}</ol>
    {(known.length > 8 || without > 0) && <div className="ranked-foot">{known.length > 8 && <span className="meta">{amount(known.length - 8)} more in the table below</span>}{without > 0 && <span className="meta">{amount(without)} without data</span>}</div>}</div>
}

/** What followed calls, which is who reached a step within some days. Asked for only once a step is chosen. */
function Followed({ report, followed, step, days, keep }) {
  const steps = [...new Set([...report.steps, ...(step ? [step] : [])])]
  return <section id="call-outcomes"><div className="section-head"><h2>Call outcomes</h2><Form className="row" method="get" action="/channels" preventScrollReset>{Object.entries(keep).map(([name, value]) => value && <input key={name} type="hidden" name={name} value={value}/>)}
      <label>Step <input name="step" list="steps" defaultValue={step} required autoComplete="off" placeholder="step" size="14"/></label><datalist id="steps">{steps.map(each => <option key={each} value={each}/>)}</datalist><label>Days <input type="number" name="days" min="1" max="365" defaultValue={days} required/></label><button className="primary">Apply</button></Form></div>
    {followed && <><p className="meta">{followed.step} within {amount(followed.days)} days of the call · {dayWords(followed.from)} – {dayWords(followed.to)} · {followed.timeZone}</p>
      <div className="panel-grid">{followed.groups.map(group => <section key={group.by}><h3>{GROUPS[group.by] ?? group.by}</h3>{group.rows.length > 0 ? <div className="wide" tabIndex="0" role="region" aria-label={GROUPS[group.by] ?? group.by}><table><thead><tr><th scope="col">Group</th><th scope="col" className="num">People</th><th scope="col" className="num">Reached</th><th scope="col" className="num">Rate</th></tr></thead>
        <tbody>{group.rows.map(row => <tr key={row.name}><td>{row.name}</td><td className="num">{amount(row.people)}</td><td className="num">{amount(row.reached)}</td><td className="num share"><Compare share={row.share}>{percent(row.share)}</Compare></td></tr>)}</tbody></table></div> : group.suppressed === 0 && <p className="muted">No data</p>}
        {group.suppressed > 0 && <p className="meta">{amount(group.suppressed)} in groups under {amount(followed.least)}, hidden</p>}</section>)}</div>
      <p className="meta">Excluded: {amount(followed.excluded.first.already)} already at this step, {amount(followed.excluded.first.running)} still within {amount(followed.days)} days. Callback: {amount(followed.excluded.returned.already)} already at this step, {amount(followed.excluded.returned.running)} still within {amount(followed.days)} days, {amount(followed.excluded.returned.through)} called again.</p></>}</section>
}

/** What each campaign cost and brought in. */
export function Channels({ model }) {
  const { report, then, before, by, per, rank, step, days, followed } = model
  const all = report.total
  // Shown as money where the report names one currency. Where it mixes them, a sign would say something false.
  let coin
  try {
    if (report.currencies.length === 1) coin = new Intl.NumberFormat('en-US', { style: 'currency', currency: report.currencies[0] })
  } catch {}
  const cash = n => coin ? coin.format(n) : amount(n)
  const kept = { from: report.from, to: report.to, by, per, rank, step, days: step ? String(days) : '' }
  const address = now => '/channels?' + new URLSearchParams(Object.entries({ ...kept, ...now }).filter(([, value]) => value))
  const less = (...names) => Object.fromEntries(Object.entries(kept).filter(([name]) => !names.includes(name)))
  // Compared only where the days before hold something of the same kind, in the same one currency.
  const alike = then.rows > 0 && report.currencies.length <= 1 && String(then.currencies) === String(report.currencies)
  const stages = report.steps.filter(each => all.stages[each])
  const withheld = row => <span className="muted" title={row === all ? 'Insufficient cost data' : 'Cost data for ' + row.costDays + ' of ' + report.days + ' days'}>Low data</span>
  const each = row => row.costPerOutcome !== null ? cash(row.costPerOutcome) : row.insufficientData ? withheld(row) : none
  const back = row => row.returnOnCost !== null ? row.returnOnCost.toFixed(1) + '×' : row.insufficientData ? withheld(row) : none
  const missing = row => row !== all && row.missingDays > 0 && (row.costDays > 0 || row.insufficientData) && <span className="reason" title={amount(row.missingDays) + ' of ' + amount(report.days) + ' days have no cost data'}>{many(row.missingDays, 'day', 'days')} missing</span>
  const spent = row => row.source === '(none)' ? <><td className="num edge">{none}</td><td className="num">{none}</td></> : unpriced(row) ? <><td className="num edge">{unknown}</td><td className="num">{unknown}</td></> : <><td className="num edge">{cash(row.cost)}{missing(row)}</td><td className="num">{amount(row.clicks)}</td></>
  // How many people, where that is not how many outcomes, because a renewal is a second outcome and not a second person.
  const reached = row => <>{stages.map((stage, i) => <td key={stage} className={i === 0 ? 'num edge' : 'num'}>{row.stages[stage] ? <>{amount(row.stages[stage].count)}{row.stages[stage].people !== row.stages[stage].count && <span className="reason">{many(row.stages[stage].people, 'person', 'people')}</span>}</> : tally(0)}</td>)}<td className={stages.length ? 'num' : 'num edge'}>{tally(row.people)}</td>{all.missed > 0 && <td className="num">{tally(row.missed)}</td>}</>
  const cells = row => <>{spent(row)}<td className="num">{tally(row.visits)}</td>{reached(row)}<td className="num edge">{cash(row.value)}</td><td className="num">{each(row)}</td><td className="num">{back(row)}</td></>
  const spurned = row => row.notLeads > 0 && amount(row.notLeads) + ' not a lead'
  const note = parts => parts.some(Boolean) && <span className="reason" title={parts.filter(Boolean).join(' · ')}>{parts.filter(Boolean).join(' · ')}</span>
  // A campaign is charged whole, so its cost, clicks and arrivals stay on its own line and are not split.
  const split = (row, key) => (row.breakdown ?? []).filter(part => part.outcomes + part.missed + part.notLeads > 0 || part.name === '(not set)').map(part => <tr className="part" key={key + '/' + part.name}><td/><td className="who">{part.name === '(not set)' ? 'Not set' : part.name}{part.notLeads > 0 && <span className="reason">{spurned(part)}</span>}</td><td className="edge"/><td/><td/>{reached(part)}<td className="num edge">{cash(part.value)}</td><td/><td/></tr>)
  const excludes = report.excluded > 0 ? 'Excludes ' + many(report.excluded, 'campaign', 'campaigns') : ''
  const brought = report.rows.filter(row => row.source !== '(none)')
  const said = report.rows.filter(row => row.reported)
  const most = Math.max(1, ...said.flatMap(row => [row.reported.conversions, row.reported.credited]))
  const claim = (claim, bars) => <><td className="num">{amount(claim.days)}</td><td className="bar">{bars}</td><td className="num edge">{amount(claim.conversions)}</td><td className="num">{tally(claim.credited)}</td><td className="num edge">{claim.value === null ? unknown : cash(claim.value)}</td><td className="num">{cash(claim.creditedValue)}</td></>
  const timed = stages.filter(stage => all.stages[stage].delay)
  // What outcomes were first worth and are worth now. A step value is a guess until the real amount is known.
  const losses = [['refunded', 'Refunded'], ['writtenOff', 'Written off']].filter(([key]) => [all.valueChange, ...report.months].some(change => change[key] !== 0))
  const valued = change => <><td className="num">{amount(change.outcomes)}</td><td className="num">{change.outcomes === change.firstUnknown ? unknown : amount(change.first)}{change.firstUnknown > 0 && change.firstUnknown < change.outcomes && <span className="reason">of {amount(change.outcomes - change.firstUnknown)}</span>}</td><td className="num">{amount(change.now)}</td>{losses.map(([key]) => <td className="num" key={key}>{change[key] === 0 ? tally(0) : amount(change[key])}</td>)}<td className="num">{tally(change.zeroed)}</td><td className="num">{tally(change.firstUnknown)}</td></>
  const heads = <><th scope="col" className="num">Outcomes</th><th scope="col" className="num">Initial value</th><th scope="col" className="num">Current value</th>{losses.map(([key, text]) => <th scope="col" className="num" key={key}>{text}</th>)}<th scope="col" className="num">Reduced to zero</th><th scope="col" className="num">No initial value</th></>
  const whose = row => row.source === '(none)' ? 'Unattributed' : row.source + (row.campaign || row.campaignId ? ' · ' + (row.campaign || row.campaignId) : '')
  const submit = event => event.currentTarget.form?.requestSubmit()
  return <><section><PageHead view="channels" title="Channels"><PeriodForm action="/channels" from={report.from} to={report.to} today={model.today} keep={less('from', 'to')}/></PageHead>
    {report.rows.length > 0 && <Tiles items={[
      ['Spend', all.costDays > 0 ? cash(all.cost) : 'No data', all.missingDays > 0 && all.costDays > 0 && many(all.missingDays, 'day', 'days') + ' without data', '', alike && all.missingDays === 0 && then.total.missingDays === 0 && then.total.costDays > 0 && <Change now={all.cost} was={then.total.cost} before={before}/>],
      ['Value', cash(all.value), many(all.outcomes, 'outcome', 'outcomes'), '', alike && !report.incomplete && <Change now={all.value} was={then.total.value} before={before} good="up"/>],
      ['People', amount(all.people), amount(all.visits) + ' visits', '', then.rows > 0 && !report.incomplete && <Change now={all.people} was={then.total.people} before={before} good="up"/>],
      [per ? 'Cost per ' + per : 'Cost per outcome', all.costPerOutcome !== null ? cash(all.costPerOutcome) : all.insufficientData ? 'Low data' : '—', excludes],
      ['ROAS', all.returnOnCost !== null ? all.returnOnCost.toFixed(1) + '×' : all.insufficientData ? 'Low data' : '—', excludes],
      all.missed > 0 && ['Missed calls', amount(all.missed), '', '', then.rows > 0 && <Change now={all.missed} was={then.total.missed} before={before} good="down"/>],
    ]}/>}
    <div className="report-meta"><p className="meta">{dayWords(report.from)} – {dayWords(report.to)} · {report.timeZone}{report.currencies.length === 1 && ' · ' + report.currencies[0]}</p>
      {report.incomplete && <p className="banner"><b>Recent results are incomplete. </b>Conversions can take up to {amount(report.incomplete.days)} days (95th percentile). Visits since {dayWords(report.incomplete.after)} may still convert.</p>}</div></section>
  {brought.length > 1 && <section id="comparison"><h2>Campaign comparison</h2><Ranked label="Campaign comparison" rows={brought} rank={rank} address={address} named={row => <><Sourced name={row.source}/><span className="ranked-what">{row.campaign || row.campaignId || 'Unnamed'}</span></>} measures={[
    ...(report.currencies.length <= 1 ? [['Value', row => row.value, cash], ['Spend', row => unpriced(row) ? null : row.cost, cash]] : []),
    ['People', row => row.people, amount, false], ['Visits', row => row.visits, amount], ...stages.map(stage => [stage, row => row.stages[stage]?.count ?? 0, amount]),
  ]}/></section>}
  <section id="campaigns"><div className="section-head"><h2>Campaigns</h2><Form className="row" method="get" action="/channels" preventScrollReset>{Object.entries(less('by', 'per')).map(([name, value]) => value && <input key={name} type="hidden" name={name} value={value}/>)}
      <label>Breakdown <select name="by" defaultValue={by} onChange={submit}><option value="">None</option>{[...new Set([...report.dimensions, ...(by ? [by] : [])])].map(dimension => <option key={dimension} value={dimension}>{dimensionName(dimension)}</option>)}</select></label>
      <label>Cost per <select name="per" defaultValue={per} onChange={submit}><option value="">All outcomes</option>{[...new Set([...report.steps, ...(per ? [per] : [])])].map(stage => <option key={stage} value={stage}>{stage}</option>)}</select></label><button>Show</button>
      {report.rows.length > 0 && <a className="button" href={'/channels/csv?' + new URLSearchParams(Object.entries({ from: report.from, to: report.to, by, per }).filter(([, value]) => value))} download>Save as CSV</a>}</Form></div>
    {report.currencies.length > 1 && <p className="apart">Multiple currencies: {report.currencies.join(', ')}</p>}
    {report.rows.length > 0 ? <div className="wide" tabIndex="0" role="region" aria-label="Channels"><table className="campaign-report"><thead>
      <tr><th scope="colgroup" colSpan="2" className="group">Attribution</th><th scope="colgroup" colSpan="3" className="edge group">Traffic</th><th scope="colgroup" colSpan={stages.length + 1 + (all.missed > 0 ? 1 : 0)} className="edge group">Outcomes</th><th scope="colgroup" colSpan="3" className="edge group">Performance</th></tr>
      <tr><th scope="col">Source</th><th scope="col">Campaign</th><th scope="col" className="num edge">Spend</th><th scope="col" className="num">Clicks</th><th scope="col" className="num">Visits</th>{stages.map((stage, i) => <th scope="col" key={stage} className={i === 0 ? 'num edge' : 'num'}>{stage}</th>)}<th scope="col" className={stages.length ? 'num' : 'num edge'}>People</th>{all.missed > 0 && <th scope="col" className="num" title="Missed calls" aria-label="Missed calls">Missed</th>}
        <th scope="col" className="num edge">Value</th><th scope="col" className="num" title={per ? 'Cost per ' + per : 'Cost per outcome'}>Cost / {per || 'outcome'}</th><th scope="col" className="num">ROAS</th></tr></thead>
      <tbody>{report.rows.map((row, i) => [<tr key={i}><td>{row.source === '(none)' ? <span className="muted">Unattributed</span> : <Sourced name={row.source}/>}</td><td className="who">{row.campaign || row.campaignId ? <span className="ranked-what" title={row.campaign || row.campaignId}>{row.campaign || row.campaignId}</span> : none}{note([row.campaign && row.campaignId, spurned(row)])}</td>{cells(row)}</tr>, ...split(row, i)])}
        <tr className="sum"><td>Total</td><td className="who">{note([report.excluded > 0 && excludes + ' with low data', spurned(all)])}</td>{cells(all)}</tr>{split(all, 'total')}</tbody></table></div> : <p className="muted">No campaigns</p>}</section>
  {all.reported && <section><h2>Platform-reported conversions</h2><div className="wide" tabIndex="0" role="region" aria-label="Platform-reported conversions"><table className="claims"><thead><tr><td/><td/><td/><th scope="colgroup" colSpan="2" className="edge group">{per || 'Conversions'}</th><th scope="colgroup" colSpan="2" className="edge group">Value</th></tr>
      <tr><th scope="col">Campaign</th><th scope="col" className="num">Days</th><th scope="col">Reported / attributed</th><th scope="col" className="num edge">Reported</th><th scope="col" className="num">Attributed</th><th scope="col" className="num edge">Reported</th><th scope="col" className="num">Attributed</th></tr></thead>
      <tbody>{said.map((row, i) => <tr key={i}><td className="who"><Sourced name={row.source}/> {row.campaign || row.campaignId || 'Unnamed'}</td>{claim(row.reported, <span className="claim"><Meter share={row.reported.conversions / most}/><Meter share={row.reported.credited / most}/></span>)}</tr>)}{said.length > 1 && <tr className="sum"><td className="who">Total</td>{claim(all.reported, '')}</tr>}</tbody></table></div></section>}
  {timed.length > 0 && <section><h2>Time to convert</h2><div className="wide" tabIndex="0" role="region" aria-label="Time to convert"><table><thead><tr><th scope="col">Step</th><th scope="col" className="num">Outcomes</th><th scope="col" className="num">Median</th><th scope="col" className="num">95th percentile</th><th scope="col" className="num">Within window</th></tr></thead>
    <tbody>{timed.map(stage => {
      const { count, median, p95, inside } = all.stages[stage].delay
      return <tr key={stage}><td>{stage}</td><td className="num">{amount(count)} of {amount(all.stages[stage].count)}</td><td className="num">{amount(median)} days</td><td className="num">{amount(p95)} days</td><td className="num share"><Compare share={inside}>{percent(inside)}</Compare></td></tr>
    })}</tbody></table></div></section>}
  {all.valueChange.outcomes > 0 && <section><h2>Value changes</h2><div className="panel-grid value-grid">
    <section><h3>By campaign</h3><div className="wide" tabIndex="0" role="region" aria-label="Value by campaign"><table><thead><tr><th scope="col">Campaign</th>{heads}</tr></thead><tbody>{report.rows.filter(row => row.valueChange.outcomes > 0).map((row, i) => <tr key={i}><td className="who">{whose(row)}</td>{valued(row.valueChange)}</tr>)}<tr className="sum"><td>Total</td>{valued(all.valueChange)}</tr></tbody></table></div></section>
    <section><h3>By month</h3><div className="wide" tabIndex="0" role="region" aria-label="Value by month"><table><thead><tr><th scope="col">Month</th>{heads}</tr></thead><tbody>{report.months.map(month => <tr key={month.month}><td>{month.month}</td>{valued(month)}</tr>)}</tbody></table></div></section></div></section>}
  <Followed report={report} followed={followed} step={step} days={days} keep={less('step', 'days')}/></>
}
