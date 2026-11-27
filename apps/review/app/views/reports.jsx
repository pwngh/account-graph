import './reports.css'
import { createContext, Fragment, useContext, useEffect, useId, useRef, useState } from 'react'
import { Form, Link, useFetcher } from 'react-router'
import { PageHead, Parts, PeriodForm, Table, Tiles, Time, Subject, ZoneContext, stamp } from './shared'
import { amount, brief, callTone, cameFrom, dayOf, dayWords, detailReply, hourOf, lasted, percent, subjectHash, ticksOf, tieWords, WHAT } from './report-words'
import { GLYPHS, Glyph, looksLike } from './marks'
import { Bars, CallInbox, Change } from './call-panels'
import { Health } from './health'
import { told } from './story'

export function CardBody({ card }) {
  return <div className="detail-body">{card.error && <p role="alert">{card.error}</p>}{card.rows.length > 0 && <dl className="detail-rows">{card.rows.map(([label, value], i) => <div key={i}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    {card.sum && <code className="detail-sum">{card.sum}</code>}{card.say?.length > 0 && <p className="detail-say">{card.say.map((say, i) => <Fragment key={i}>{i > 0 && ' '}{Array.isArray(say) ? <><strong>{say[0]}</strong>{say[1]}</> : say}</Fragment>)}</p>}
    {card.links?.length > 0 && <p className="detail-links">{card.links.map(({ text, href }, i) => <a key={i} href={href} rel="noreferrer">{text}</a>)}</p>}</div>
}

/** @type {import('react').Context<string | undefined>} */
const presentedCard = createContext(undefined)
const reportSnapshot = createContext('')

/**
 * What is behind a number or a row: a mark beside it, and the card the mark opens.
 * The card is in the page from the start, so it opens before any script has loaded.
 */
function Detail({ card, title, id, label }) {
  const fetcher = useFetcher()
  const openCard = useContext(presentedCard)
  const snapshot = useContext(reportSnapshot)
  const key = useId()
  const box = useRef(null)
  const presented = Boolean(card) && openCard === card.type
  useEffect(() => {
    if (presented && !box.current?.matches(':popover-open')) box.current?.showPopover()
  }, [presented])
  if (!card) return null
  const fresh = detailReply(card, snapshot, fetcher.data)
  const current = fresh?.card ?? card
  const name = label ?? title ?? 'Details of ' + card.title
  return <><button type="button" className="detail" id={id} popoverTarget={key} aria-label={name} title={name} data-card={card.type}/>
    <div className={current.roomy ? 'card-pop roomy' : 'card-pop'} id={key} popover="auto" ref={box} role="dialog" aria-labelledby={key + 'title'}>
      <div className="detail-head"><h4 id={key + 'title'}>{current.title}</h4>{current.value != null && <span className="detail-worth">{current.value}</span>}<button type="button" className="detail-shut" popoverTarget={key} popoverTargetAction="hide" aria-label="Close">×</button></div>
      <CardBody card={current}/>{fresh?.error && <p className="detail-failed" role="alert">{fresh.error}</p>}
      <p className="detail-links"><Link to={card.href} onClick={event => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        void fetcher.load(card.href.replace('/details/', '/card/') + '&snapshot=' + encodeURIComponent(snapshot))
      }}>{fetcher.state === 'idle' ? 'Read current details' : 'Reading…'}</Link></p></div></>
}

/**
 * A row with a bar of its share behind it. The number says the share, and the bar only lets rows be compared.
 * A script draws it, because the page's policy refuses a style written into the page.
 */
function Behind({ part, className, children }) {
  const row = useRef(null)
  useEffect(() => {
    row.current?.style.setProperty('--part', Math.max(0, Math.min(1, part)) * 100 + '%')
  }, [part])
  return <tr ref={row} className={className ? 'behind ' + className : 'behind'}>{children}</tr>
}

function Range({ from, to, timeZone }) {
  return <p className="meta">{dayWords(from)} – {dayWords(to)} · {timeZone}</p>
}

function Metric({ card, note, change, bars, tone }) {
  return card && <div className={tone || undefined}><dt>{card.title}</dt><dd><span className="tile-line"><b>{card.value ?? '—'}</b>{change}<Detail card={card}/></span>{note && <span className="reason">{note}</span>}{bars}</dd></div>
}

const ACTIVE = 'Today is the people active today, with a call or a step, in the time zone of the line under the numbers. Overdue counts only those people.'
const REACHED = { answered: 'answered', missed: 'missed', voicemail: 'voicemail', waiting: 'waiting for result', unknown: 'unknown result' }
/** How long ago, in its largest unit. The title has the time itself. */
function Age({ at, now, late = false }) {
  const zone = useContext(ZoneContext)
  return <span className={late ? 'board-age apart' : 'board-age muted'}><time dateTime={new Date(at).toISOString()} title={stamp(at, zone) + (late ? ', overdue' : '')}>{brief(now - at)}</time>{late && <span className="sr-only">, overdue</span>}</span>
}
/** One person: age, where they came from, then the step and the last call. */
function Person({ row, column, board, card }) {
  const arrival = (cameFrom(row) || 'Unattributed') + (row.language ? ' · ' + row.language : '')
  const call = row.call
  return <li><div className="top"><Subject id={row.subject} journey/><Age at={row.at} now={board.at} late={row.late}/><Detail card={card}/></div>
    <div className="board-meta reason"><span title={arrival}>{arrival}</span>{row.value > 0 && <b>{amount(row.value)} {row.currency}</b>}</div>
    <div className="board-chips">{column.step === null && row.step && <span className="chip muted">{row.step}</span>}<span className={'chip ' + (call ? callTone(call.state) : 'muted')}>{call ? (call.direction === 'outbound' ? 'Outbound' : 'Inbound') + ' · ' + REACHED[call.state] : 'No calls'}</span></div></li>
}
/** A sender nobody has answered: how long ago they wrote, where they came from, and how many texts wait. */
function Unanswered({ text, at, card }) {
  const arrival = (cameFrom(text) || 'Unattributed') + (text.tags?.language ? ' · ' + text.tags.language : '')
  return <li><div className="top"><Subject id={text.subject} journey/><Age at={text.at} now={at}/><Detail card={card}/></div>
    <div className="board-meta reason"><span title={arrival}>{arrival}</span></div>
    <div className="board-chips"><span className="chip related">{amount(text.unanswered)} unanswered</span></div></li>
}
function Board({ data }) {
  const { board, cards } = data
  const periods = [[1,'Today'],[7,'7 days'],[30,'30 days'],[90,'90 days'],[365,'1 year']]
  const late = board.columns.reduce((sum, column) => sum + (column.late ?? 0), 0)
  const textLane = !!data.texts.length && <section aria-label="Unanswered texts"><h2>Unanswered texts</h2><p className="counts"><span>{amount(data.texts.length)}{data.moreTexts && '+'} {data.texts.length === 1 ? 'person' : 'people'}</span></p>
    <div className="scroll" tabIndex="0" role="region" aria-label="Unanswered texts: people"><ol>{data.texts.map(({ text, card }) => <Unanswered key={text.id} text={text} at={board.at} card={cards[card]}/>)}</ol></div></section>
  return <><section><PageHead view="board" title="Board"><div className="row"><span id="board-period-label" title={ACTIVE}>Period</span><nav className="segments" aria-labelledby="board-period-label" aria-describedby="board-period">{periods.map(([days,name]) => <Link key={days} aria-current={days === board.days ? 'page' : undefined} to={'/board/' + days}>{name}</Link>)}</nav></div></PageHead>
    <dl className="tiles">{data.metrics.map((key,i) => <Metric key={key} card={cards[key]} tone={i === 1 && late > 0 && 'apart'} note={i === 1 && board.columns.every(col => col.late === null) && 'No limits set'}/>)}</dl><Range from={board.from} to={board.day} timeZone={board.timeZone}/>
    <p className={board.days === 1 ? 'meta' : 'sr-only'} id="board-period">{ACTIVE}</p>
    {board.unplaced > 0 && <p className="meta">{amount(board.unplaced)} more at steps outside STAGES</p>}{board.columns.length === 1 && <p>Set STAGES to add a column for each step.</p>}</section>
    <div className="board wide" tabIndex="0" role="region" aria-label="Columns">{board.columns.map((column, i) => {
      const name = column.step === null ? 'Missed calls' : column.step.toLowerCase() === 'missed calls' ? column.step + ', a step' : column.step
      const counts = [amount(column.people) + (column.people === 1 ? ' person' : ' people'), column.fresh > 0 && amount(column.fresh) + ' new', column.late > 0 && amount(column.late) + ' over ' + lasted(column.wait), column.done > 0 && amount(column.done) + (column.step === null ? ' reached' : ' advanced') + ' today']
      return <Fragment key={i}><section aria-label={name} id={'column-' + i} className={column.people ? undefined : 'idle'}><h2>{name}</h2><p className="counts">{counts.map((count, n) => count && <span key={n} className={n === 2 ? 'apart' : undefined}>{count}</span>)}</p>
      {column.rows.length > 0 && <div className="scroll" tabIndex="0" role="region" aria-label={name + ': people'}><ol>{column.rows.map((row, j) => <Person key={row.subject} row={row} column={column} board={board} card={cards[data.columns[i][j]]}/>)}</ol></div>}
      {column.people > column.rows.length && <p className="muted board-foot">{amount(column.rows.length)} of {amount(column.people)}</p>}</section>{column.step === null && textLane}</Fragment>
    })}</div></>
}

const kinds = Object.keys(WHAT)
function Story({ entry, icon }) {
  return <>{told(entry, icon).map((part,i) => <Fragment key={i}>{part}</Fragment>)}</>
}
const LANE = 36
const RULER = 42
/**
 * Events by kind and time: a lane for each kind, a mark for each event, and a number where several are too close to tell apart.
 * The marks are placed as shares of the width, so the drawing is as sharp at any size and needs no script.
 */
function Chart({ events, groups, cards }) {
  const zone = useContext(ZoneContext)
  const marks = events.filter(e => e.entry.at > 0)
  if (!marks.length) return null
  const tracks = kinds.filter(kind => marks.some(e => e.entry.kind === kind))
  const low = marks[0].entry.at
  const high = marks.at(-1).entry.at
  // A margin at each side keeps the first and the last mark whole.
  const x = at => 4 + 92 * (high === low ? .5 : (at - low) / (high - low)) + '%'
  const y = kind => RULER + tracks.indexOf(kind) * LANE + LANE / 2
  const tall = RULER + tracks.length * LANE
  /** Brings the card of a mark into view and opens it. Without a script the link goes to the card's own mark. */
  const show = card => event => {
    const mark = document.getElementById(card)
    if (!mark || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    mark.scrollIntoView({ block: 'center' })
    mark.click()
  }
  const heaps = groups.filter(group => group.count > 1 && tracks.includes(group.kind))
  return <section aria-label="Journey chart" className="chart"><div className="chart-head"><span className="meta">{stamp(low, zone)} – {stamp(high, zone)}</span>{heaps.length > 0 && <span className="row chart-heaps">{heaps.map(group => <span key={group.card} className="meta">{cards[group.card]?.title}<Detail id={group.card} card={cards[group.card]} title={cards[group.card]?.title}/></span>)}</span>}</div>
    <div className="chart-body"><div className="names"><div className="ruler"/>{tracks.map(kind => <div key={kind} className={'name ' + kind}><Glyph kind={kind}/><span>{WHAT[kind]}</span><span className="count">{amount(marks.filter(e => e.entry.kind === kind).length)}</span></div>)}</div>
    <div className="track"><svg className="plot" width="100%" height={tall} role="group" aria-label="Events by type and time">
      {ticksOf(low, high, zone).map(tick => <g key={tick.at}><line className="rule" x1={x(tick.at)} x2={x(tick.at)} y1={RULER} y2={tall}/>{tick.over && <text className="tick over" x={x(tick.at)} dx="6" y="19">{tick.over}</text>}<text className="tick" x={x(tick.at)} dx="6" y="35">{tick.text}</text></g>)}
      {marks.filter(item => item.wait).map(item => <a key={item.wait} href={'#' + item.wait} onClick={show(item.wait)} aria-label={cards[item.wait]?.title}><line className="wait" x1={x(item.entry.at)} x2={x(Math.min(high, item.entry.at + item.entry.followUp.delay))} y1={y('call')} y2={y('call')}/></a>)}
      {groups.filter(group => tracks.includes(group.kind)).map(group => <a key={group.card} className={'mark ' + group.kind + (group.look === 'missed' ? ' missed' : '')} href={'#' + group.card} onClick={show(group.card)} aria-label={cards[group.card]?.title + ', ' + dayOf(group.at, zone)}><title>{cards[group.card]?.title}</title>
        <svg x={x(group.at)} y={y(group.kind) - 13} width="1" height="26" overflow="visible">{group.count === 1 ? <><circle className="hit" cx="0" cy="13" r="13"/><path transform="translate(-8 5)" d={GLYPHS[group.look] ?? GLYPHS[group.kind]}/></> : <><rect className="heap" x="-13" y="2" width="26" height="22" rx="11"/><text className="group-count" x="0" y="17" textAnchor="middle">{group.count}</text></>}</svg></a>)}
    </svg></div></div></section>
}
function Journey({ data }) {
  const { journey, which, cards } = data
  const [hidden, setHidden] = useState([])
  const [enhanced, setEnhanced] = useState(false)
  const zone = useContext(ZoneContext)
  // The server supplies a complete timeline. Its type checkboxes appear after React can act on them.
  useEffect(() => setEnhanced(true), [])
  if (!which) return <section><PageHead view="journey" title="Journey"/><p className="muted">Select an ID</p><a href="#find">Search</a></section>
  if (!journey?.entries.length) return <section><PageHead view="journey" title={<bdi>{which}</bdi>}><Link className="button" to={subjectHash(which)}>Account</Link></PageHead><p className="muted">No events</p></section>
  const visible = data.events.filter(event => !hidden.includes(event.entry.kind))
  const dates = data.events.map(event => event.entry.at).filter(at => at > 0)
  const days = new Map()
  for (const event of visible) {
    const day = dayOf(event.entry.at, zone)
    if (!days.has(day)) days.set(day, [])
    days.get(day).push(event)
  }
  return <><section><PageHead view="journey" title={<bdi title={which}>{which}</bdi>}><Link className="button" to={subjectHash(which)}>Account</Link></PageHead>
    <Tiles items={[[ 'Events', amount(data.events.length) + (journey.next === null ? '' : '+')], ['IDs', amount(Object.keys(journey.subjects).length)], dates.length > 0 && ['First event', <Time at={dates[0]} short/>], dates.length > 0 && ['Last event', <Time at={dates.at(-1)} short/>, dates.at(-1) > dates[0] && lasted(dates.at(-1) - dates[0]) + ' later'] ]}/>{journey.more > 0 && <p className="meta">{amount(journey.more)} more IDs are not shown.</p>}
    <Chart events={visible} groups={data.groups} cards={cards}/></section><section><h2>Timeline</h2>
    {enhanced && <div className="row filters" role="group" aria-label="Show">{kinds.filter(kind => data.events.some(e => e.entry.kind === kind)).map(kind => <label key={kind} className={kind}><input type="checkbox" checked={!hidden.includes(kind)} onChange={() => setHidden(hidden.includes(kind) ? hidden.filter(k => k !== kind) : [...hidden,kind])}/><Glyph kind={kind}/>{WHAT[kind]}<span className="count">{amount(data.events.filter(e => e.entry.kind === kind).length)}</span></label>)}</div>}
    {days.size === 0 && <p className="muted">All event types are hidden.</p>}<div className="wide timeline"><ol className="journey">{[...days].map(([day, events]) => <li className="day" key={day}><h3>{day}</h3><ol>{events.map(({entry, mark, call, wait}, i) => <li className="timeline-entry" key={mark ?? i} id={call ? 'call-' + encodeURIComponent(entry.call.id) : undefined}><span className="num">{entry.at > 0 ? <time dateTime={new Date(entry.at).toISOString()} title={stamp(entry.at, zone)}>{hourOf(entry.at, zone)}</time> : <span className="muted">No data</span>}</span><span className={'chip kind ' + entry.kind}><Glyph kind={looksLike(entry)}/>{WHAT[entry.kind]}</span><div className="what"><Story entry={entry} icon={call && <Detail card={cards[call]}/>}/></div><div className="why"><Subject id={entry.subject}/>{mark && <Detail card={cards[mark]} id={mark} title={WHAT[entry.kind] + ' details'}/>}{wait && <Detail card={cards[wait]} id={wait} title={cards[wait]?.title}/>}<span className="reason">{tieWords(journey.subjects[entry.subject],which)}</span></div></li>)}</ol></li>)}</ol></div>{journey.next != null && <Link className="button" to={data.canonical + '?before=' + journey.next}>Show earlier</Link>}</section></>
}

const measures = [['calls','All calls'],['answered','Answered'],['missed','Missed'],['voicemail','Voicemail'],['unknown','Unknown'],['waiting','Waiting for result'],['returned','Returned']]
function Hours({ data }) {
  const { summary, measure } = data
  const title = measures.find(([name]) => name === measure)[1]
  const cells = new Map(summary.cells.map(cell => [cell.weekday * 24 + cell.hour, cell]))
  const most = Math.max(1,...summary.cells.map(cell => cell[measure]))
  const hours = Array.from({length:24},(_,i) => i)
  return <section id="calls-hours"><div className="section-head"><h2>Calls by hour</h2><Form className="row" method="get" action="/calls"><input type="hidden" name="from" value={summary.from}/><input type="hidden" name="to" value={summary.to}/><label>Result <select name="measure" defaultValue={measure}>{measures.map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label> <button>Show</button></Form></div>
    <div className="wide" tabIndex="0" role="region" aria-label="Calls by hour"><table className="hours"><caption>{title} · {dayWords(summary.from)} – {dayWords(summary.to)} · {summary.timeZone}</caption><thead><tr><th>Weekday</th>{hours.map(h => <th key={h}>{String(h).padStart(2,'0')}</th>)}<th>All</th></tr></thead><tbody>{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((day,i) => {
      const row = hours.map(h => cells.get((i + 1) * 24 + h))
      return <tr key={day}><th scope="row">{day}</th>{row.map((cell,h) => <td className={'num heat' + Math.ceil(4 * (cell?.[measure] || 0) / most)} key={h}>{cell?.[measure]}</td>)}<td>{amount(row.reduce((all, cell) => all + (cell?.[measure] || 0), 0))}</td></tr>
    })}</tbody></table></div></section>
}
function Calls({ data }) {
  const { summary, open, cards, then } = data
  const { total, coverage } = summary
  const lost = total.missed + total.voicemail
  const hourly = key => Array.from({length: 24}, (_, h) => summary.cells.filter(c => c.hour === h).reduce((a,c) => a + c[key], 0))
  const notes = [undefined, amount(total.answered) + ' of ' + amount(total.calls), total.calls > 0 && percent(lost / total.calls) + (summary.closed ? ' · ' + amount(summary.closed.missed + summary.closed.voicemail) + ' after hours' : ''), amount(total.returned) + ' of ' + amount(lost) + (summary.returnedWithin == null ? '' : ' · median ' + lasted(summary.returnedWithin)), data.oldest && <>Oldest <Time at={data.oldest} now={open.at}/></>]
  const changes = then.calls > 0 ? [<Change now={total.calls} was={then.calls} before={data.before}/>, <Change now={total.answered / total.calls} was={then.answered / then.calls} before={data.before} good="up" points/>, <Change now={lost} was={then.missed + then.voicemail} before={data.before} good="down"/>] : []
  const missed = hourly('missed')
  const bars = [<Bars values={hourly('calls')} title="Calls by starting hour"/>, undefined, <Bars values={hourly('voicemail').map((n,i) => n + missed[i])} title="Missed calls by starting hour"/>]
  const results = [['Answered',total.answered,total.calls,''],['Missed',total.missed,total.calls,''],['Voicemail',total.voicemail,total.calls,''],['Waiting',total.waiting,total.calls,'Result not received yet'],['Unknown',total.unknown,total.calls,'Result unavailable'],['Returned',total.returned,lost,[summary.returnedWithin != null && 'Median ' + lasted(summary.returnedWithin),total.reported > 0 && amount(total.reported) + ' reported by another system'].filter(Boolean).join(' · ')],['Called again',total.calledAgain,lost,'Caller got through later']]
  if (total.notLeads > 0) results.push(['Not a lead',total.notLeads,0,'Excluded from other counts'])
  return <><section><PageHead view="calls" title="Calls"><PeriodForm action="/calls" from={summary.from} to={summary.to} today={data.today}/></PageHead><Range {...summary}/>
  {total.calls > 0 && <dl className="tiles">{data.metrics.map((key,i) => (i !== 3 || lost > 0) && <Metric key={key} card={cards[key]} tone={i === 4 && (open.calls.length > 0 ? 'apart' : 'same')} note={notes[i]} change={changes[i]} bars={bars[i]}/>)}</dl>}</section><section id="calls-missed"><h2>Missed calls</h2>
  {open.calls.length ? <CallInbox data={data} Detail={Detail} Story={Story}/> : <p className="muted">{total.calls === 0 ? 'No inbound calls' : lost > 0 ? 'All missed callers have been reached.' : 'No missed calls'}</p>}
  {total.hidden > 0 && <p className="muted">{amount(total.hidden)} more with a withheld number</p>}</section>{total.calls > 0 && <><div className="panel-grid call-grid"><section><h2>Call results</h2><Table title="Call results" headers={['Result',['Calls','num'],['Share','num'],'Detail']}>{results.map(([name,n,all,note], i) => <Behind key={name} part={all > 0 ? n / all : 0} className={i === 5 ? 'second' : undefined}><th scope="row"><span className={'chip ' + callTone(name.toLowerCase())}>{name}</span></th><td className="num">{n > 0 ? amount(n) : <span className="muted">0</span>}<Detail card={cards[data.results[name]]} label={'Details of ' + name + ', ' + amount(n) + ', in Call results'}/></td><td className="num share">{all > 0 ? percent(n / all) : <span className="muted">—</span>}</td><td className="muted">{note}</td></Behind>)}</Table></section><section><h2>Call attribution</h2><Parts label="Call attribution" list={[['Visitor', coverage.visitor], ['Phone number', coverage.channel], ['Unmatched', coverage.neither]]}/>{coverage.noResult > 0 && <p className="meta">{amount(coverage.noResult)} without a result</p>}</section></div><Hours data={data}/></>}</>
}

/** @param {{ data: Record<string, any>, openCard?: string }} props */
export function Report({ data, openCard }) {
  const view = data.kind === 'journey' ? <Journey key={data.which} data={data}/> : data.kind === 'board' ? <Board data={data}/> : data.kind === 'health' ? <Health data={data} Detail={Detail}/> : <Calls data={data}/>
  return <reportSnapshot.Provider value={data.snapshot}><presentedCard.Provider value={openCard}>{view}</presentedCard.Provider></reportSnapshot.Provider>
}
