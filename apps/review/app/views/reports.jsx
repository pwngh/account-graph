import './reports.css'
import { createContext, Fragment, useContext, useEffect, useState } from 'react'
import { Form, Link, useFetcher } from 'react-router'
import { Table, Tiles, Time, Subject } from './shared'
import { amount, cameFrom, dayOf, detailReply, lasted, percent, subjectHash, tieWords, WHAT } from './report-words'
import { Bars, CallInbox, Change, Coverage } from './call-panels'
import { told } from './story'

export function CardBody({ card }) {
  return <div className="detail-body">{card.error && <p role="alert">{card.error}</p>}{card.rows.length > 0 && <dl className="detail-rows">{card.rows.map(([label, value], i) => <div key={i}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    {card.sum && <code className="detail-sum">{card.sum}</code>}{card.say?.length > 0 && <p className="detail-say">{card.say.map((say, i) => <Fragment key={i}>{i > 0 && ' '}{Array.isArray(say) ? <><strong>{say[0]}</strong>{say[1]}</> : say}</Fragment>)}</p>}
    {card.links?.length > 0 && <p className="detail-links">{card.links.map(({ text, href }, i) => <a key={i} href={href} rel="noreferrer">{text}</a>)}</p>}</div>
}

/** @type {import('react').Context<string | undefined>} */
const presentedCard = createContext(undefined)
const reportSnapshot = createContext('')

function Detail({ card, title = 'Details', id }) {
  const fetcher = useFetcher()
  const openCard = useContext(presentedCard)
  const snapshot = useContext(reportSnapshot)
  if (!card) return null
  const fresh = detailReply(card, snapshot, fetcher.data)
  const current = fresh?.card ?? card
  return <details className="report-detail" data-card={card.type} open={openCard === card.type || undefined}><summary aria-label={'Details of ' + card.title}>{title}</summary>
    <h4 id={id} tabIndex={id ? -1 : undefined}>{current.title} {current.value}</h4><CardBody card={current}/>
    {fresh?.error && <p role="alert">{fresh.error}</p>}<Link to={card.href} onClick={event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      void fetcher.load(card.href.replace('/details/', '/card/') + '&snapshot=' + encodeURIComponent(snapshot))
    }}>{fetcher.state === 'idle' ? 'Read current details' : 'Reading…'}</Link></details>
}

function Range({ from, to, timeZone }) {
  return <p className="meta">{from} – {to} · {timeZone}</p>
}

function Metric({ card, note, change, bars }) {
  return card && <div><dt>{card.title}</dt><dd><span className="tile-line"><b>{card.value ?? '—'}</b>{change}</span>{note && <span className="reason">{note}</span>}<Detail card={card}/>{bars}</dd></div>
}

const ACTIVE = 'Today is the people active today, with a call or a step, in the time zone of the line under the numbers. Overdue counts only those people.'
function Board({ data }) {
  const { board, cards } = data
  const periods = [[1,'Today'],[7,'7 days'],[30,'30 days'],[90,'90 days'],[365,'1 year']]
  const textLane = !!data.texts.length && <section aria-label="Unanswered texts"><h2>Unanswered texts</h2><p>{data.texts.length}{data.moreTexts && '+'} {data.texts.length === 1 ? 'person' : 'people'}</p><ol>{data.texts.map(({ text, card }) => <li key={text.id}><Subject id={text.subject} journey/> <Time at={text.at}/><p>{cameFrom(text) || 'Unattributed'}</p><span className="chip related">{amount(text.unanswered)} unanswered</span><Detail card={cards[card]}/></li>)}</ol></section>
  return <><section><div className="page-head"><h2>Board</h2><div className="row"><span id="board-period-label" title={ACTIVE}>Period</span><nav aria-labelledby="board-period-label" aria-describedby="board-period">{periods.map(([days,name]) => <Link key={days} className="button" aria-current={days === board.days ? 'page' : undefined} to={'/board/' + days}>{name}</Link>)}</nav></div></div>
    <dl className="tiles">{data.metrics.map((key,i) => <Metric key={key} card={cards[key]} note={i === 1 && board.columns.every(col => col.late === null) && 'No limits set'}/>)}</dl><Range from={board.from} to={board.day} timeZone={board.timeZone}/>
    <p className={board.days === 1 ? 'meta' : 'sr-only'} id="board-period">{ACTIVE}</p>
    {board.unplaced > 0 && <p>{amount(board.unplaced)} more at steps outside STAGES</p>}{board.columns.length === 1 && <p>Set STAGES to add a column for each step.</p>}</section>
    <div className="board wide" tabIndex="0" role="region" aria-label="Columns">{board.columns.map((column, i) => {
      const name = column.step === null ? 'Missed calls' : column.step.toLowerCase() === 'missed calls' ? column.step + ', a step' : column.step
      return <Fragment key={i}><section aria-label={name} id={'column-' + i} className={column.people ? '' : 'idle'}><h2>{name}</h2><p className="counts">{[amount(column.people) + (column.people === 1 ? ' person' : ' people'), column.fresh > 0 && amount(column.fresh) + ' new', column.late > 0 && amount(column.late) + ' over ' + lasted(column.wait), column.done > 0 && amount(column.done) + (column.step === null ? ' reached' : ' advanced') + ' today'].filter(Boolean).join(' · ')}</p>
      {column.rows.length > 0 && <div className="scroll" tabIndex="0" role="region" aria-label={name + ': people'}><ol>{column.rows.map((row, j) => <li key={row.subject}><div className="top"><Subject id={row.subject} journey/><span className={'board-age ' + (row.late ? 'apart' : 'muted')} title={new Date(row.at).toISOString()}>{lasted(board.at - row.at)}{row.late && ' overdue'}</span></div><div className="board-meta reason">{cameFrom(row) || 'Unattributed'}{row.language && ' · ' + row.language} {row.value > 0 && <b>{amount(row.value)} {row.currency}</b>}</div><div className="board-chips">{column.step === null && row.step && <span className="chip">{row.step}</span>} <span className="chip">{row.call ? (row.call.direction === 'outbound' ? 'Outbound' : 'Inbound') + ' · ' + ({waiting:'waiting for result',unknown:'unknown result'}[row.call.state] || row.call.state) : 'No calls'}</span></div><Detail card={cards[data.columns[i][j]]}/></li>)}</ol></div>}
      {column.people > column.rows.length && <p>{amount(column.rows.length)} of {amount(column.people)}</p>}</section>{column.step === null && textLane}</Fragment>
    })}</div></>
}

const kinds = Object.keys(WHAT)
function Story({ entry }) {
  return <>{told(entry).map((part,i) => <Fragment key={i}>{part}</Fragment>)}</>
}
function Chart({ events, groups, cards }) {
  const marks = events.filter(e => e.entry.at > 0)
  if (!marks.length) return null
  const tracks = kinds.filter(kind => marks.some(e => e.entry.kind === kind))
  const low = marks[0].entry.at
  const high = marks.at(-1).entry.at
  const x = at => 114 + 640 * (high === low ? .5 : (at - low) / (high - low))
  const y = kind => 32 + tracks.indexOf(kind) * 34
  return <section><h2>Journey chart</h2><svg className="report-chart" viewBox={'0 0 784 ' + (tracks.length * 34 + 36)} aria-label="Events by type and time" role="group"><g>{
    tracks.map(kind => <g key={kind}><text x="8" y={y(kind) + 5}>{WHAT[kind]}</text><line x1="104" x2="767" y1={y(kind)} y2={y(kind)}/></g>)
  }{marks.filter(item => item.wait).map(item => <a key={item.wait} href={'#' + item.wait} aria-label={cards[item.wait]?.title}><line className="wait" x1={x(item.entry.at)} x2={x(Math.min(high,item.entry.at + item.entry.followUp.delay))} y1={y('call') + 9} y2={y('call') + 9}/></a>)}{
    groups.filter(group => tracks.includes(group.kind)).map(group => <a key={group.card} href={'#' + group.card} aria-label={cards[group.card]?.title + ', ' + dayOf(group.at)}><title>{cards[group.card]?.title}</title><circle cx={x(group.at)} cy={y(group.kind)} r={group.count === 1 ? 6 : 12}/>{group.count > 1 && <text className="group-count" x={x(group.at)} y={y(group.kind) + 3} textAnchor="middle">{group.count}</text>}</a>)
  }</g><text x="100" y={tracks.length * 34 + 28}>{dayOf(low)}</text><text x="770" textAnchor="end" y={tracks.length * 34 + 28}>{dayOf(high)}</text></svg>
  {groups.filter(g => g.count > 1 && tracks.includes(g.kind)).map(group => <Detail key={group.card} id={group.card} card={cards[group.card]} title={cards[group.card]?.title}/>)}</section>
}
function Journey({ data }) {
  const { journey, which, cards } = data
  const [hidden, setHidden] = useState([])
  const [enhanced, setEnhanced] = useState(false)
  // The server supplies a complete timeline. Its type checkboxes appear after React can act on them.
  useEffect(() => setEnhanced(true), [])
  if (!which) return <section><h2>Journey</h2><p>Select an ID</p><a href="#find">Search</a></section>
  if (!journey?.entries.length) return <section><h2><bdi>{which}</bdi></h2><Subject id={which}/><p>No events</p></section>
  const visible = data.events.filter(event => !hidden.includes(event.entry.kind))
  const dates = data.events.map(event => event.entry.at).filter(at => at > 0)
  const days = new Map()
  for (const event of visible) {
    const day = dayOf(event.entry.at)
    if (!days.has(day)) days.set(day, [])
    days.get(day).push(event)
  }
  return <><section><div className="page-head"><h2><bdi>{which}</bdi></h2><Link className="button" to={subjectHash(which)}>Account</Link></div>
    <Tiles items={[[ 'Events', amount(data.events.length) + (journey.next === null ? '' : '+')], ['IDs', amount(Object.keys(journey.subjects).length)], dates.length > 0 && ['First event', <Time at={dates[0]}/>], dates.length > 0 && ['Last event', <Time at={dates.at(-1)}/>, dates.at(-1) > dates[0] && lasted(dates.at(-1) - dates[0]) + ' later'] ]}/>{journey.more > 0 && <p>{amount(journey.more)} more IDs are not shown.</p>}</section>
    <Chart events={visible} groups={data.groups} cards={cards}/><section><h2>Timeline</h2>
    {enhanced && <div className="row filters" role="group" aria-label="Show">{kinds.filter(kind => data.events.some(e => e.entry.kind === kind)).map(kind => <label key={kind}><input type="checkbox" checked={!hidden.includes(kind)} onChange={() => setHidden(hidden.includes(kind) ? hidden.filter(k => k !== kind) : [...hidden,kind])}/>{WHAT[kind]}</label>)}</div>}
    {days.size === 0 && <p>All event types are hidden.</p>}<div className="wide timeline"><ol className="journey">{[...days].map(([day, events]) => <li className="day" key={day}><h3>{day}</h3><ol>{events.map(({entry, mark, call, wait}, i) => <li className="timeline-entry" key={mark ?? i} id={call ? 'call-' + encodeURIComponent(entry.call.id) : undefined}><span className="num"><Time at={entry.at || undefined}/></span><span className={'chip kind ' + entry.kind}>{WHAT[entry.kind]}</span><div className="what"><Story entry={entry}/>{call && <Detail card={cards[call]}/>}</div><div className="why"><Subject id={entry.subject}/><span className="reason">{tieWords(journey.subjects[entry.subject],which)}</span>{mark && <Detail card={cards[mark]} id={mark} title={WHAT[entry.kind] + ' details'}/>}
    {wait && <Detail card={cards[wait]} id={wait} title={cards[wait]?.title}/>}</div></li>)}</ol></li>)}</ol></div>{journey.next != null && <Link className="button" to={data.canonical + '?before=' + journey.next}>Show earlier</Link>}</section></>
}

const measures = [['calls','All calls'],['answered','Answered'],['missed','Missed'],['voicemail','Voicemail'],['unknown','Unknown'],['waiting','Waiting for result'],['returned','Returned']]
function Hours({ data }) {
  const { summary, measure } = data
  const title = measures.find(([name]) => name === measure)[1]
  const cells = new Map(summary.cells.map(cell => [cell.weekday * 24 + cell.hour, cell]))
  const most = Math.max(1,...summary.cells.map(cell => cell[measure]))
  const hours = Array.from({length:24},(_,i) => i)
  return <section id="calls-hours"><h2>Calls by hour</h2><Form method="get" action="/calls"><input type="hidden" name="from" value={summary.from}/><input type="hidden" name="to" value={summary.to}/><label>Result <select name="measure" defaultValue={measure}>{measures.map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label> <button>Show</button></Form>
    <div className="wide" tabIndex="0" role="region" aria-label="Calls by hour"><table className="hours"><caption>{title} · {summary.from} – {summary.to} · {summary.timeZone}</caption><thead><tr><th>Weekday</th>{hours.map(h => <th key={h}>{String(h).padStart(2,'0')}</th>)}<th>All</th></tr></thead><tbody>{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((day,i) => {
      const row = hours.map(h => cells.get((i + 1) * 24 + h))
      return <tr key={day}><th scope="row">{day}</th>{row.map((cell,h) => <td className={'num heat' + Math.ceil(4 * (cell?.[measure] || 0) / most)} key={h}>{cell?.[measure]}</td>)}<td>{amount(row.reduce((all, cell) => all + (cell?.[measure] || 0), 0))}</td></tr>
    })}</tbody></table></div></section>
}
function Calls({ data }) {
  const { summary, open, cards, then } = data
  const { total, coverage } = summary
  const lost = total.missed + total.voicemail
  const hourly = key => Array.from({length: 24}, (_, h) => summary.cells.filter(c => c.hour === h).reduce((a,c) => a + c[key], 0))
  const notes = [undefined, amount(total.answered) + ' of ' + amount(total.calls), total.calls > 0 && percent(lost / total.calls) + (summary.closed ? ' · ' + amount(summary.closed.missed + summary.closed.voicemail) + ' after hours' : ''), amount(total.returned) + ' of ' + amount(lost) + (summary.returnedWithin == null ? '' : ' · median ' + lasted(summary.returnedWithin)), data.oldest && <>Oldest <Time at={data.oldest}/></>]
  const changes = then.calls > 0 ? [<Change now={total.calls} was={then.calls} before={data.before}/>, <Change now={total.answered / total.calls} was={then.answered / then.calls} before={data.before} good="up" points/>, <Change now={lost} was={then.missed + then.voicemail} before={data.before} good="down"/>] : []
  const missed = hourly('missed')
  const bars = [<Bars values={hourly('calls')} title="Calls by starting hour"/>, undefined, <Bars values={hourly('voicemail').map((n,i) => n + missed[i])} title="Missed calls by starting hour"/>]
  const results = [['Answered',total.answered,total.calls,''],['Missed',total.missed,total.calls,''],['Voicemail',total.voicemail,total.calls,''],['Waiting',total.waiting,total.calls,'Result not received yet'],['Unknown',total.unknown,total.calls,'Result unavailable'],['Returned',total.returned,lost,[summary.returnedWithin != null && 'Median ' + lasted(summary.returnedWithin),total.reported > 0 && amount(total.reported) + ' reported by another system'].filter(Boolean).join(' · ')],['Called again',total.calledAgain,lost,'Caller got through later']]
  if (total.notLeads > 0) results.push(['Not a lead',total.notLeads,0,'Excluded from other counts'])
  return <><section><div className="page-head"><h2>Calls</h2><Form className="row" action="/calls" method="get"><label>From <input type="date" name="from" required defaultValue={summary.from}/></label><label>To <input type="date" name="to" required defaultValue={summary.to}/></label><button>Show</button></Form></div><Range {...summary}/>
  {total.calls > 0 && <dl className="tiles">{data.metrics.map((key,i) => (i !== 3 || lost > 0) && <Metric key={key} card={cards[key]} note={notes[i]} change={changes[i]} bars={bars[i]}/>)}</dl>}</section><section id="calls-missed"><h2>Missed calls</h2>
  {open.calls.length ? <CallInbox data={data} Detail={Detail} Story={Story}/> : <p>{total.calls === 0 ? 'No inbound calls' : lost > 0 ? 'All missed callers have been reached.' : 'No missed calls'}</p>}
  {total.hidden > 0 && <p>{amount(total.hidden)} more with a withheld number</p>}</section>{total.calls > 0 && <><div className="panel-grid call-grid"><section><h2>Call results</h2><Table title="Call results" headers={['Result','Calls','Share','Detail']}>{results.map(([name,n,all,note]) => <tr key={name}><th scope="row">{name}</th><td>{amount(n)}</td><td>{all ? percent(n / all) : '—'}</td><td>{note}</td></tr>)}</Table></section><section><h2>Call attribution</h2><Coverage coverage={coverage}/></section></div><Hours data={data}/></>}</>
}

/** @param {{ data: Record<string, any>, openCard?: string }} props */
export function Report({ data, openCard }) {
  const view = data.kind === 'journey' ? <Journey key={data.which} data={data}/> : data.kind === 'board' ? <Board data={data}/> : <Calls data={data}/>
  return <reportSnapshot.Provider value={data.snapshot}><presentedCard.Provider value={openCard}>{view}</presentedCard.Provider></reportSnapshot.Provider>
}
