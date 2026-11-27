import { Fragment, useContext, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { amount, cameFrom, idText, journeyHash, percent, subjectHash } from './report-words'
import { Time, ZoneContext, stamp } from './shared'
import { Glyph, Tile, looksLike } from './marks'

export function Change({ now, was, before, good, points }) {
  if (!Number.isFinite(now) || !Number.isFinite(was)) return null
  const by = points ? now - was : was === 0 ? (now === 0 ? 0 : undefined) : (now - was) / Math.abs(was)
  const way = by === undefined || by > .0049 ? 'up' : by < -.0049 ? 'down' : 'level'
  const tone = way === 'level' || good === undefined ? '' : way === good ? 'same' : 'apart'
  const size = Math.abs(by)
  const label = by === undefined ? 'new' : way === 'level' ? 'no change' : (way === 'up' ? '+' : '−') + (size >= 10 ? amount(Math.round(size)) + '×' : points ? amount(Math.round(size * 100)) + ' pts' : percent(size))
  const prior = points ? percent(was) : amount(was)
  return <span className={'change ' + way + ' ' + tone} title={'Previous period: ' + prior + ' (' + before.from + ' – ' + before.to + ')'}>{label}<span className="sr-only">, previously {prior}</span></span>
}

export function Bars({ values, title }) {
  const maximum = Math.max(1, ...values)
  return <svg className="shape" viewBox={'0 0 ' + values.length * 4 + ' 24'} role="img" aria-label={title} preserveAspectRatio="none">{values.map((n,i) => {
    const height = n === 0 ? 1 : Math.max(1.5, 24 * n / maximum)
    return <rect key={i} className={n === 0 ? 'none' : ''} x={i * 4 + .5} y={24 - height} width="3" height={height} rx=".6"><title>{String(i).padStart(2,'0') + ':00 · ' + amount(n)}</title></rect>
  })}</svg>
}

export function Coverage({ coverage }) {
  const measures = [['Visitor',coverage.visitor], ['Phone number',coverage.channel], ['Unmatched',coverage.neither]]
  const [off,setOff] = useState([])
  const [enabled,setEnabled] = useState(false)
  useEffect(() => setEnabled(true), [])
  const full = measures.reduce((sum,[,n]) => sum + n, 0)
  const kept = measures.reduce((sum,[key,n]) => sum + (off.includes(key) ? 0 : n), 0)
  let left = 0
  return <><div className="split-bar"><p className="parts-whole"><b>{amount(kept)}</b>{off.length ? ' of ' + amount(full) : ' total'}</p><svg className="coverage-bar" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">{measures.map(([name,n],i) => {
    if (!n || off.includes(name)) return null
    const x = left
    left += n / kept * 100
    return <rect key={name} className={'part' + i} x={x} width={left - x} height="14"/>
  })}</svg><ul className="legend labels">{measures.map(([name,n],i) => {
    const contents = <><span className={'key part' + i}/><span>{name}</span> <b>{amount(n)}</b> <span className="muted">{off.includes(name) ? 'hidden' : kept ? percent(n / kept) : '—'}</span></>
    return <li key={name}>{enabled ? <button type="button" aria-pressed={!off.includes(name)} onClick={() => setOff(off.includes(name) ? off.filter(k => k !== name) : [...off,name])}>{contents}</button> : contents}</li>
  })}</ul>{off.length > 0 && <p role="status">Shares exclude hidden items.</p>}</div>{coverage.noResult > 0 && <p>{amount(coverage.noResult)} without a result</p>}</>
}

// Copying needs a script. Without one the time is on the page to select.
function CopyTime({ at }) {
  const [enhanced, setEnhanced] = useState(false)
  const [said, setSaid] = useState('')
  const zone = useContext(ZoneContext)
  useEffect(() => setEnhanced(true), [])
  if (!enhanced) return null
  const text = stamp(at, zone)
  return <div className="row"><button type="button" onClick={async () => {
    try {
      await navigator.clipboard.writeText(text)
      setSaid('Copied')
    } catch {
      setSaid(text)
    }
  }}>Copy time</button><span className="meta" role="status">{said}</span></div>
}

/** Missed calls nobody returned: the list, the caller's story so far, and what is known of the call, side by side. */
export function CallInbox({ data, Detail, Story }) {
  const { open, cards, summary, story, result } = data
  const url = (page, result, pick) => '/calls?' + new URLSearchParams({ from: summary.from, to: summary.to, page, measure: data.measure, result, ...(pick && {pick}) })
  // The oldest waits longest, so the oldest group is first.
  const groups = { Older: [], 'This week': [], Today: [] }
  open.calls.forEach((call,i) => {
    if (result !== 'all' && call.state !== result) return
    groups[open.at - call.at < 86400_000 ? 'Today' : open.at - call.at < 7 * 86400_000 ? 'This week' : 'Older'].push([call,i])
  })
  const selected = open.calls[data.picked]
  const lost = call => call.state === 'voicemail' ? 'Voicemail' : 'Missed'
  return <><div className="inbox"><div className="inbox-side"><nav className="segments" aria-label="Result">{[['all','All'],['missed','Missed'],['voicemail','Voicemail']].map(([v,name]) => <Link aria-current={v === result ? 'page' : undefined} key={v} to={url(data.page,v) + '#calls-missed'}>{name}<span className="count">{amount(open.calls.filter(call => v === 'all' || call.state === v).length)}</span></Link>)}</nav>
    <div className="inbox-list scroll" role="region" aria-label="Missed calls" tabIndex="0">{Object.entries(groups).map(([label,rows]) => rows.length > 0 && <div key={label}><h3 className="inbox-age">{label}<span className="count">{amount(rows.length)}</span></h3><ol>{rows.map(([call,i]) => <li key={call.id} className={i === data.picked ? 'inbox-call on' : 'inbox-call'}><Tile kind={call.state === 'voicemail' ? 'voicemail' : 'missed'} tone={call.state === 'voicemail' ? 'related' : 'apart'}/><Link to={url(data.page,result,data.calls[i]) + '#call-history'} className="inbox-who" aria-current={i === data.picked ? 'true' : undefined} title={call.subject}>{idText(call.subject)}</Link><span className="inbox-time"><Time at={call.at} now={open.at}/></span><span className="inbox-from">{lost(call)} · {cameFrom(call) || 'Unattributed'}</span>{call.attempts > 0 && <span className="chip">{amount(call.attempts)} {call.attempts === 1 ? 'attempt' : 'attempts'}</span>}<Detail card={cards[data.calls[i]]}/></li>)}</ol></div>)}{!selected && <p className="muted inbox-age">None</p>}</div></div>
    {selected && story && <><div id="call-history" className="inbox-story"><div className="inbox-head"><div><b title={selected.subject}>{idText(selected.subject)}</b><div className="meta">{lost(selected)} · <Time at={selected.at} now={open.at}/><Detail card={cards[data.calls[data.picked]]}/></div></div><Link className="button primary" to={journeyHash(selected.subject)}>Open journey</Link><Link className="button" to={subjectHash(selected.subject)}>Account</Link></div>
    <p className="inbox-age">History<span className="count">{amount(story.count)}{story.more && '+'}</span>{story.ids > 1 && <span className="meta"> · {amount(story.ids)} IDs</span>}</p><ol className="story">{story.rows.map(({entry,card},i) => <li key={i} className={entry.kind + (entry.call?.id === selected.id ? ' this' : '')}><Glyph kind={looksLike(entry)}/><div className="what"><Story entry={entry} icon={card && <Detail card={cards[card]}/>}/></div><span className="meta"><Time at={entry.at || undefined} now={open.at}/></span></li>)}</ol>{story.count > 14 && <p className="meta">{amount(story.count - 14)} more in the journey</p>}</div>
    <div className="inbox-facts"><dl><dt>Called</dt><dd><Time at={selected.at}/></dd><dt>Wait</dt><dd>{selected.result?.waited == null ? <span className="muted">No data</span> : amount(Math.round(selected.result.waited)) + ' s'}</dd><dt>Attempts</dt><dd>{selected.attempts > 0 ? amount(selected.attempts) : <span className="muted">0</span>}</dd><dt>Source</dt><dd>{cameFrom(selected) || <span className="muted">Unattributed</span>}</dd>{Object.entries(selected.tags ?? {}).map(([key,value]) => <Fragment key={key}><dt>{key.replaceAll('_',' ')}</dt><dd>{String(value)}</dd></Fragment>)}</dl><CopyTime key={selected.id} at={selected.at}/></div></>}
    </div>{data.page > 0 && <Link className="button" to={url(data.page - 1, result)}>Previous calls</Link>} {open.next != null && <Link className="button" to={url(data.page + 1, result)}>Show more</Link>}</>
}
