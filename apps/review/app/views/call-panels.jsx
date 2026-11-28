import { useId, Fragment, useContext, useEffect, useState } from 'react'
import { Link, useFetcher, useLocation } from 'react-router'
import { amount, cameFrom, journeyHash, percent, subjectHash } from './report-words'
import { Answer, Named, Time, ZoneContext, stamp } from './shared'
import { Glyph, Tile, looksLike } from './marks'
import { Info } from './terms'

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

/**
 * What a reviewer says of the open missed call, behind a button: that the caller was reached, or that it was nobody's inquiry.
 * The answer is shown above the list, because the call leaves the list once it is said.
 */
export function SayOfCall({ intent, call, formKey, at, label, look = 'button', title, children }) {
  const { pathname, search } = useLocation()
  const fetcher = useFetcher({ key: 'said-of-call' })
  const [enhanced, setEnhanced] = useState(false)
  useEffect(() => setEnhanced(true), [])
  const busy = fetcher.state !== 'idle'
  const pop = useId()
  const form = <fetcher.Form method="post" action={pathname + search} preventScrollReset>
    {enhanced && <input type="hidden" name="_enhanced" value="1"/>}<input type="hidden" name="intent" value={intent}/><input type="hidden" name="call" value={call}/><input type="hidden" name="key" value={formKey}/><input type="hidden" name="at" value={at}/>
    {children}<button type="submit" className="primary" aria-disabled={busy} disabled={busy}>{busy ? 'Saving…' : label}</button></fetcher.Form>
  // On a Board card the form opens over the page, as the card's details do. A column fades its ends with a mask, and a mask hides whatever is drawn inside it.
  if (look === 'pop') return <><button type="button" className="say" popoverTarget={pop}>{label}</button><div className="card-pop say-pop" popover="auto" id={pop} role="dialog" aria-labelledby={pop + 'title'}>
    <div className="detail-head"><h4 id={pop + 'title'}>{title}</h4><button type="button" className="detail-shut" popoverTarget={pop} popoverTargetAction="hide" aria-label="Close">×</button></div>{form}</div></>
  return <details className={'decision-form ' + look + (intent === 'reached' && look === 'button' ? ' primary' : '')}><summary>{label}</summary>{form}</details>
}

/** What saying "not a lead" does, and why it is said. */
export function NotLead() {
  return <><p>Takes this call out of the counts and off the waiting list. If a conversion was sent for it, the ad platform is told to withdraw it where it can. It is recorded under your name.</p><label>Why <select name="why" defaultValue="other"><option value="other">Not an inquiry</option><option value="spam">Spam</option></select></label></>
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
  const said = useFetcher({ key: 'said-of-call' })
  return <><Answer result={said.data}/><div className="inbox"><div className="inbox-side"><nav className="segments" aria-label="Result">{[['all','All'],['missed','Missed'],['voicemail','Voicemail']].map(([v,name]) => <Link aria-current={v === result ? 'page' : undefined} key={v} to={url(data.page,v) + '#calls-missed'}>{name}<span className="count">{amount(open.calls.filter(call => v === 'all' || call.state === v).length)}</span></Link>)}</nav>
    <div className="inbox-list scroll" role="region" aria-label="Missed calls" tabIndex="0">{Object.entries(groups).map(([label,rows]) => rows.length > 0 && <div key={label}><h3 className="inbox-age">{label}<span className="count">{amount(rows.length)}</span></h3><ol>{rows.map(([call,i]) => <li key={call.id} className={i === data.picked ? 'inbox-call on' : 'inbox-call'}><Tile kind={call.state === 'voicemail' ? 'voicemail' : 'missed'} tone={call.state === 'voicemail' ? 'related' : 'apart'}/><Link to={url(data.page,result,data.calls[i]) + '#call-history'} className="inbox-who" aria-current={i === data.picked ? 'true' : undefined}  title={call.subject}><Named id={call.subject}/></Link><span className="inbox-time"><Time at={call.at} now={open.at}/></span><span className="inbox-from">{lost(call)} · {cameFrom(call) || 'Unattributed'}</span>{call.attempts > 0 && <span className="chip">{amount(call.attempts)} {call.attempts === 1 ? 'attempt' : 'attempts'}</span>}<Detail card={cards[data.calls[i]]}/></li>)}</ol></div>)}{!selected && <p className="muted inbox-age">None</p>}</div></div>
    {selected && story && <><div id="call-history" className="inbox-story"><div className="inbox-head"><div><b className="term"><Named id={selected.subject}/><Info id="callerId"/></b><div className="meta">{lost(selected)} · <Time at={selected.at} now={open.at}/><Detail card={cards[data.calls[data.picked]]}/></div></div><Link className="button primary" to={journeyHash(selected.subject)}>Open journey</Link><Link className="button" to={subjectHash(selected.subject)}>Account</Link></div>
    <div className="row inbox-acts" role="group" aria-label="This call"><SayOfCall key={selected.id + '/reached'} intent="reached" call={selected.id} formKey={data.snapshot} at={open.at} label="Reached them"><p>Says that somebody reached this caller, by a call the phone system did not report, a text or in person. Their missed calls stop waiting. It is recorded under your name.</p></SayOfCall>
      <SayOfCall key={selected.id + '/not-lead'} intent="not_lead" call={selected.id} formKey={data.snapshot} at={open.at} label="Not a lead"><NotLead/></SayOfCall></div>
    <p className="inbox-age">History<span className="count">{amount(story.count)}{story.more && '+'}</span>{story.ids > 1 && <span className="meta"> · {amount(story.ids)} IDs</span>}</p><ol className="story">{story.rows.map(({entry,card},i) => <li key={i} className={entry.kind + (entry.call?.id === selected.id ? ' this' : '')}><Glyph kind={looksLike(entry)}/><div className="what"><Story entry={entry} icon={card && <Detail card={cards[card]}/>} at={open.at}/></div><span className="meta"><Time at={entry.at || undefined} now={open.at}/></span></li>)}</ol>{story.count > 14 && <p className="meta">{amount(story.count - 14)} more in the journey</p>}</div>
    <div className="inbox-facts"><dl><dt>Called</dt><dd><Time at={selected.at}/></dd><dt>Wait</dt><dd>{selected.result?.waited == null ? <span className="muted">No data</span> : amount(Math.round(selected.result.waited)) + ' s'}</dd><dt>Attempts</dt><dd>{selected.attempts > 0 ? amount(selected.attempts) : <span className="muted">0</span>}</dd><dt>Source</dt><dd>{cameFrom(selected) || <span className="muted">Unattributed</span>}</dd>{Object.entries(selected.tags ?? {}).map(([key,value]) => <Fragment key={key}><dt>{key.replaceAll('_',' ')}</dt><dd>{String(value)}</dd></Fragment>)}</dl><CopyTime key={selected.id} at={selected.at}/></div></>}
    </div>{data.page > 0 && <Link className="button" to={url(data.page - 1, result)}>Previous calls</Link>} {open.next != null && <Link className="button" to={url(data.page + 1, result)}>Show more</Link>}</>
}
