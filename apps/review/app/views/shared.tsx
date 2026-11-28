import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Form, Link, useFetcher, useLocation } from 'react-router'
import { subjectPath } from '../navigation'
import { ICONS, PERSON, typeOf } from './cluster-layout.js'
import { ViewMark, type ViewName } from './marks'
import { Term } from './terms'
import { idText, lasted } from './report-words.js'

export const amount = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
export const percent = (n: number) => Math.round(n * 100) + '%'
/** The reviewer's time zone, from the root loader. The server and the browser format a time alike. */
export const ZoneContext = createContext('UTC')
const formatters = new Map<string, Intl.DateTimeFormat>()
export function stamp(at: number, timeZone = 'UTC') {
  let formatter = formatters.get(timeZone)
  if (!formatter) formatters.set(timeZone, formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }))
  return formatter.format(at)
}
/**
 * A time. Given `now`, it says how long ago, as a list with little room does, and its title has the time itself.
 * `short` leaves the zone to the title, for a page that names the zone once.
 */
export function Time({ at, now, short = false }: { at?: number, now?: number, short?: boolean }) {
  const zone = useContext(ZoneContext)
  if (at == null || !Number.isFinite(at)) return <span className="muted">No data</span>
  const exact = new Date(at).toISOString()
  if (short) return <time dateTime={exact} title={stamp(at, zone) + ' · ' + exact}>{new Date(at).toLocaleString('en-US', { timeZone: zone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
  if (now === undefined) return <time dateTime={exact} title={exact}>{stamp(at, zone)}</time>
  return <time dateTime={exact} title={stamp(at, zone) + ' · ' + exact}>{lasted(Math.abs(now - at))}{now >= at ? ' ago' : ' from now'}</time>
}

/** What a person is called: the values the graph keeps of their group, and the record of the firm's own that stands for one the graph made. */
export interface Called { name?: string, phone?: string, email?: string, record?: string, phones?: string[], emails?: string[], dob?: string, address?: string }
/** What each person a page lists is called, by ID. A page sets it from what its loader read. */
export const CalledContext = createContext<Record<string, Called>>({})

/** A phone number as a person writes it, where it is a North American one, and as kept otherwise. */
export function shownPhone(phone: string) {
  const national = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone)
  return national ? '(' + national[1] + ') ' + national[2] + '-' + national[3] : phone
}

/**
 * What to show for a person: their name, else their phone number, else the record of the firm's own that stands for them,
 * else the ID, shortened where it is a long hash.
 */
export function nameOf(id: string, called?: Called) {
  return called?.name ?? (called?.phone && shownPhone(called.phone)) ?? (called?.record && idText(called.record)) ?? idText(id)
}

/** The same, read from the page: `useNamed()(id)`. */
export function useNamed() {
  const called = useContext(CalledContext)
  return (id: string) => nameOf(id, called[id])
}

/** Everything known of who an ID is, for a title: the ID itself, then the record that stands for it, and every number and email read for it, the newest first. */
export function knownOf(id: string, called?: Called) {
  const phones = called?.phones ?? (called?.phone ? [called.phone] : [])
  const emails = called?.emails ?? (called?.email ? [called.email] : [])
  return [id, called?.record, ...phones.map(shownPhone), ...emails].filter(Boolean).join(' · ')
}

/** A person's name or number as text, where a link of its own would not do. The ID and what else is known of them are in the title. */
export function Named({ id }: { id: string }) {
  const called = useContext(CalledContext)[id]
  return <bdi title={knownOf(id, called)}>{nameOf(id, called)}</bdi>
}

// A person is shown by name or number. The ID, which may be a long hash, is in the title and on the account page.
export function Subject({ id, journey = false }: { id: string, journey?: boolean }) {
  const called = useContext(CalledContext)[id]
  return <Link className="link subject" title={knownOf(id, called)} to={subjectPath(id, journey ? 'journey' : 'accounts')}><bdi>{nameOf(id, called)}</bdi></Link>
}

// Another system's decisions are signed system:<name>. The original screen says system <name>.
export function Author({ by }: { by?: string | null }) {
  return by?.startsWith('system:') ? <span className="chip" title="Sent by another system">system <bdi>{by.slice(7)}</bdi></span> : by ? <bdi>{by}</bdi> : <span>Unknown</span>
}

export function Badge({ id }: { id: string }) {
  const kind = typeOf(id)
  return <svg className={'badge ' + (['account', 'visitor', 'lead', 'caller', 'contact', 'person'].includes(kind) ? kind : '')} viewBox="-11 -11 22 22" aria-hidden="true"><circle r="10"/><path className={ICONS[kind] ? 'line' : ''} d={ICONS[kind] || PERSON} transform="scale(.82)"/></svg>
}

/** A table that scrolls sideways where it must. A heading given as `['Score', 'num', 'score']` has that class and the definition at that place. */
export function Table({ title, headers, children }: { title: string, headers: (string | [string, string, string?])[], children: ReactNode }) {
  return <div className="wide" tabIndex={0} role="region" aria-label={title}><table><thead><tr>{headers.map(h => typeof h === 'string' ? <th key={h} scope="col">{h}</th> : <th key={h[0]} scope="col" className={h[1] || undefined}>{h[2] ? <Term id={h[2]}>{h[0]}</Term> : h[0]}</th>)}</tr></thead><tbody>{children}</tbody></table></div>
}

/**
 * The days a report covers: the usual spans counted back from today, and two dates.
 * `keep` is what else the address holds, carried into the new one.
 */
export function PeriodForm({ action, from, to, today, keep = {} }: { action: string, from: string, to: string, today: string, keep?: Record<string, string> }) {
  const ago = (n: number) => new Date(Date.parse(today + 'T00:00:00Z') - n * 86400_000).toISOString().slice(0, 10)
  const spans = [['Today', today, today], ['Yesterday', ago(1), ago(1)], ['7 days', ago(6), today], ['30 days', ago(29), today], ['This month', today.slice(0, 8) + '01', today]]
  return <Form className="row period" action={action} method="get">{Object.entries(keep).map(([name, value]) => value && <input key={name} type="hidden" name={name} value={value}/>)}<label>From <input type="date" name="from" required defaultValue={from}/></label><label>To <input type="date" name="to" required defaultValue={to}/></label><button className="primary">Show</button>
    <nav className="presets" aria-label="Period">{spans.map(([label, start, end]) => <Link key={label} aria-current={start === from && end === to ? 'page' : undefined} to={action + '?' + new URLSearchParams({ from: start, to: end, ...Object.fromEntries(Object.entries(keep).filter(([, value]) => value)) })}>{label}</Link>)}</nav></Form>
}

/** The heading of a view: its mark, its name, and the controls of the whole view. */
export function PageHead({ view, title, children }: { view: ViewName, title: ReactNode, children?: ReactNode }) {
  return <div className="page-head"><h2 className="page-title"><ViewMark name={view}/>{title}</h2>{children}</div>
}

export interface Reason { identifier: string, evidence: number, fanout: number, gap: number, group?: string, counted?: false }
const apartBy = (gap: number) => {
  const days = Math.round(gap / 86400000)
  return gap === 0 ? 'same time' : days < 1 ? '<1 day apart' : days + (days === 1 ? ' day apart' : ' days apart')
}
/** Why two IDs are linked: each shared identifier with its weight, how many IDs have it and how far apart they used it, and the way to ignore it. */
export function Reasons({ reasons, context, subject }: { reasons: Reason[], context: WriteContext, subject: string }) {
  // One of a group counts, and the others of the group follow it, said not to count. The group is named only where it left one out.
  const mates = (reason: Reason) => reasons.filter(other => reason.group !== undefined && other.group === reason.group && other.counted === false)
  const line = (r: Reason) => <div className={'reason' + (r.counted === false ? ' uncounted' : '')} key={r.identifier}><b>{r.identifier.split(':')[0]}</b> {percent(r.evidence)} · {r.fanout} IDs · {apartBy(r.gap)}{r.group === undefined ? '' : r.counted === false ? ' · not counted (' + r.group + ' group)' : mates(r).length > 0 ? ' · ' + r.group + ' group' : ''}<DecisionForm context={context} intent="mute" subject={subject} identifier={r.identifier} look="link"/></div>
  return <>{reasons.filter(reason => reason.counted !== false).flatMap(reason => [line(reason), ...mates(reason).map(line)])}</>
}

/** A share drawn as a bar beside its number. The number says it, and the bar only lets rows be compared. */
/** A share as a bar. `marks` are lines across it at other shares, each with a class, as a scale has. */
export function Meter({ share, marks = [] }: { share: number, marks?: [number, string][] }) {
  const at = (n: number) => Math.max(0, Math.min(1, n)) * 100
  return <span className={marks.length ? 'meter scale' : 'meter'} aria-hidden="true"><svg viewBox="0 0 100 8" preserveAspectRatio="none" focusable="false"><rect className="track" x="0" y="2" width="100" height="4"/><rect className="fill" x="0" y="2" width={at(share)} height="4"/>{marks.map(([n, name]) => <line key={name} className={name} x1={at(n)} x2={at(n)} y1="0" y2="8" vectorEffect="non-scaling-stroke"/>)}</svg></span>
}

/**
 * Parts of a whole as one bar, and the same numbers as a list under it.
 * A part pressed in the list is left out, and the rest are shares of what is left.
 */
export function Parts({ label, list }: { label: string, list: [string, number][] }) {
  const [off, setOff] = useState<string[]>([])
  const [enabled, setEnabled] = useState(false)
  useEffect(() => setEnabled(true), [])
  const full = list.reduce((sum, [, n]) => sum + n, 0)
  const kept = list.reduce((sum, [name, n]) => sum + (off.includes(name) ? 0 : n), 0)
  let left = 0
  return <div className="split-bar"><p className="parts-whole"><b>{amount(kept)}</b>{off.length ? ' of ' + amount(full) : ' total'}</p>
    <svg className="parts-bar" width="100%" height="30" aria-hidden="true" focusable="false">{list.map(([name, n], i) => {
      if (!n || off.includes(name)) return null
      const [x, wide] = [left, n / kept * 100]
      left += wide
      return <g key={name}><rect className={'part' + i} x={x + '%'} width={wide + '%'} height="30"/>{wide >= 9 && <text x={x + wide / 2 + '%'} y="19" textAnchor="middle">{percent(n / kept)}</text>}</g>
    })}</svg>
    <ul className="legend labels" aria-label={label}>{list.map(([name, n], i) => {
      const contents = <><span className={'key part' + i}/><span>{name}</span> <b>{amount(n)}</b> <span className="muted">{off.includes(name) ? 'hidden' : kept ? percent(n / kept) : '—'}</span></>
      return <li key={name}>{enabled ? <button type="button" aria-pressed={!off.includes(name)} onClick={() => setOff(off.includes(name) ? off.filter(each => each !== name) : [...off, name])}>{contents}</button> : contents}</li>
    })}</ul>{off.length > 0 && <p className="meta" role="status">Shares exclude hidden items.</p>}</div>
}
export function Compare({ share, children }: { share: number, children: ReactNode }) {
  return <span className="compare"><Meter share={share}/><span>{children}</span></span>
}

/** A list that scrolls inside its own height, so a long one does not push the rest of the page down. */
export function Scroll({ label, children }: { label: string, children: ReactNode }) {
  return <div className="scroll" tabIndex={0} role="region" aria-label={label}>{children}</div>
}

/** The few numbers a view is about, large, each with what it is of. The fourth of an item is its tone, for one that needs someone. */
export function Tiles({ items }: { items: ([string | [string, string, string?], ReactNode, ReactNode?, string?, ReactNode?] | false | undefined | null | 0 | '')[] }) {
  return <dl className="tiles">{items.map(item => {
    if (!item) return null
    // A name given with the place of its definition, as `['Spend', 'spend']`, has the mark beside it.
    const [name, term, more] = typeof item[0] === 'string' ? [item[0]] : item[0]
    return <div key={name} className={item[3] || undefined}><dt>{term ? <Term id={term} more={more}>{name}</Term> : name}</dt><dd><span className="tile-line"><b>{item[1]}</b>{item[4]}</span>{item[2] && <span className="reason">{item[2]}</span>}</dd></div>
  })}</dl>
}

export interface ActionResult {
  saved?: string
  error?: string
  sent?: { target: string, action: string, at: number, transactionId: string, state: string, note?: string }[]
}

export function Answer({ result }: { result?: ActionResult }) {
  if (!result) return null
  return <>{result.error && <p className="apart" role="alert">{result.error}</p>}{result.saved && <p role="status">{result.saved}</p>}{!!result.sent?.length && <section><h2>Data held by ad platforms</h2><p>This ID was deleted here. This list is shown once, so save a copy.</p><Table title="Data held by ad platforms" headers={['Platform', 'Conversion', 'Date', 'Transaction', 'Status']}>{result.sent.map((row, i) => <tr key={i}><td>{row.target}</td><td>{row.action}</td><td><Time at={row.at}/></td><td>{row.transactionId}</td><td>{row.state === 'accepted' ? 'Retraction accepted' : row.state === 'rejected' ? 'Retraction rejected' : 'Not requested'} {row.note}</td></tr>)}</Table></section>}</>
}

const decisionKey = createContext<{ key: string, enhanced: boolean, remember: (control: HTMLElement | null) => void } | undefined>(undefined)

// Keep the reply and any platform retraction receipt on the page after the successful write removes its form.
export function DecisionScope({ children }: { children: ReactNode }) {
  const key = useId()
  const fetcher = useFetcher<ActionResult>({ key })
  const [enhanced, setEnhanced] = useState(false)
  useEffect(() => setEnhanced(true), [])
  const result = useRef<HTMLDivElement>(null)
  const control = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (fetcher.data && fetcher.state === 'idle' && document.activeElement === document.body) {
      const previous = control.current
      const next = previous?.isConnected ? previous.closest('details:not([open])')?.querySelector('summary') ?? previous : result.current
      next?.focus({ preventScroll: true })
    }
  }, [fetcher.data, fetcher.state])
  return <decisionKey.Provider value={{ key, enhanced, remember: element => { control.current = element } }}><div ref={result} tabIndex={-1}><Answer result={fetcher.data}/></div>{children}</decisionKey.Provider>
}

export interface WriteContext { key: string, at: number, seen: number }
export type Intent = 'join' | 'unjoin' | 'separate' | 'rejoin' | 'mute' | 'restore' | 'forget'
/** A decision, behind the control that opens its form. `look` is how the control is drawn: a button, or a quiet link inside a row. */
export function DecisionForm({ context, intent, subject, other, identifier, targets, label, look = 'button', keys }: { context: WriteContext, intent: Intent, subject: string, other?: string, identifier?: string, targets?: string[], label?: string, look?: 'button' | 'link' | 'primary', keys?: string }) {
  const id = useId()
  const { pathname, search } = useLocation()
  const scope = useContext(decisionKey)
  const fetcher = useFetcher<ActionResult>({ key: scope?.key })
  const [opened, setOpened] = useState<WriteContext | null>(null)
  const submitted = useRef(false)
  const details = useRef<HTMLDetailsElement>(null)
  const shown = opened ?? context
  useEffect(() => {
    if (submitted.current && fetcher.state === 'idle' && fetcher.data) {
      submitted.current = false
      if (fetcher.data.saved && details.current) {
        details.current.open = false
        details.current.querySelector('form')?.reset()
        setOpened(null)
      }
    }
  }, [fetcher.data, fetcher.state])
  const busy = fetcher.state !== 'idle'
  const button = { join: 'Join', unjoin: 'Undo join', separate: 'Separate', rejoin: 'Remove', mute: 'Ignore', restore: 'Restore', forget: 'Delete data' }[intent]
  return <details className={'decision-form ' + look + (intent === 'forget' ? ' danger' : '')} ref={details} onToggle={event => {
    // A live read may replace the audit head while the reviewer is writing a reason.
    setOpened(event.currentTarget.open ? context : null)
  }}><summary aria-keyshortcuts={keys}>{label || button}{keys && <kbd>{keys.toUpperCase()}</kbd>}</summary><fetcher.Form method="post" action={pathname + search} preventScrollReset onSubmit={event => {
    if (busy) event.preventDefault()
    else {
      submitted.current = true
      scope?.remember(document.activeElement instanceof HTMLElement ? document.activeElement : null)
    }
  }}>
    {scope?.enhanced && <input type="hidden" name="_enhanced" value="1"/>}
    {Object.entries({ intent, key: shown.key + id, seen: shown.seen, at: shown.at, subject, other, identifier }).map(([name, value]) => value != null && <input key={name} type="hidden" name={name} value={value}/>)}
    {intent === 'join' && !other && <label>Other ID <input name="other" placeholder="account:42" required maxLength={500}/></label>}
    <p>{intent === 'forget' ? 'All data recorded for ' + subject + ' will be permanently deleted.' : intent === 'join' ? subject + ' and the other ID will be treated as one person.' : intent === 'unjoin' ? 'The decision that joined ' + subject + ' and ' + other + ' is taken back. They stay together only where other evidence links them.' : intent === 'separate' ? subject + ' and ' + other + ' will be treated as different people.' : intent === 'rejoin' ? subject + ' and ' + other + ' can be joined again.' : identifier}</p>
    <label>Reason <input name="reason" maxLength={1000}/></label>
    {intent === 'forget' && <>{!!targets?.length && <label><input type="checkbox" name="retract" value="yes"/> Ask {targets.join(', ')} to retract conversions</label>}<label><input type="checkbox" name="confirm" value="yes" required/> Permanently delete {subject}</label></>}
    <button type="submit" className={intent === 'forget' ? 'danger' : 'primary'} aria-disabled={busy} disabled={busy}>{busy ? 'Saving…' : button}</button>
    {!scope && <Answer result={fetcher.data}/>}
  </fetcher.Form></details>
}
