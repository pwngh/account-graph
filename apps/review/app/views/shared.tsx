import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, useFetcher, useLocation } from 'react-router'
import { subjectPath } from '../navigation'
import { ICONS, PERSON, typeOf } from './cluster-layout.js'
import { ViewMark, type ViewName } from './marks'
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

// As on the original screen, a long ID such as a caller's hash is shortened in a link and given in full in its title.
export function Subject({ id, journey = false }: { id: string, journey?: boolean }) {
  return <Link className="link subject" title={id} to={subjectPath(id, journey ? 'journey' : 'accounts')}><bdi>{idText(id)}</bdi></Link>
}

// Another system's decisions are signed system:<name>. The original screen says system <name>.
export function Author({ by }: { by?: string | null }) {
  return by?.startsWith('system:') ? <span className="chip" title="Sent by another system">system <bdi>{by.slice(7)}</bdi></span> : by ? <bdi>{by}</bdi> : <span>Unknown</span>
}

export function Badge({ id }: { id: string }) {
  const kind = typeOf(id)
  return <svg className={'badge ' + (['account', 'visitor', 'lead', 'caller', 'contact', 'person'].includes(kind) ? kind : '')} viewBox="-11 -11 22 22" aria-hidden="true"><circle r="10"/><path className={ICONS[kind] ? 'line' : ''} d={ICONS[kind] || PERSON} transform="scale(.82)"/></svg>
}

/** A table that scrolls sideways where it must. A heading given with a class, as `['Calls', 'num']`, has it. */
export function Table({ title, headers, children }: { title: string, headers: (string | [string, string])[], children: ReactNode }) {
  return <div className="wide" tabIndex={0} role="region" aria-label={title}><table><thead><tr>{headers.map(h => typeof h === 'string' ? <th key={h} scope="col">{h}</th> : <th key={h[0]} scope="col" className={h[1]}>{h[0]}</th>)}</tr></thead><tbody>{children}</tbody></table></div>
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
export function Meter({ share }: { share: number }) {
  return <span className="meter" aria-hidden="true"><svg viewBox="0 0 100 8" preserveAspectRatio="none" focusable="false"><rect className="track" x="0" y="2" width="100" height="4"/><rect className="fill" x="0" y="2" width={Math.max(0, Math.min(1, share)) * 100} height="4"/></svg></span>
}
export function Compare({ share, children }: { share: number, children: ReactNode }) {
  return <span className="compare"><Meter share={share}/><span>{children}</span></span>
}

/** A list that scrolls inside its own height, so a long one does not push the rest of the page down. */
export function Scroll({ label, children }: { label: string, children: ReactNode }) {
  return <div className="scroll" tabIndex={0} role="region" aria-label={label}>{children}</div>
}

export function Tiles({ items }: { items: ([string, ReactNode, ReactNode?] | false | undefined)[] }) {
  return <dl className="tiles">{items.map(item => item && <div key={item[0]}><dt>{item[0]}</dt><dd><span className="tile-line"><b>{item[1]}</b></span>{item[2] && <span className="reason">{item[2]}</span>}</dd></div>)}</dl>
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
export type Intent = 'join' | 'separate' | 'rejoin' | 'mute' | 'restore' | 'forget'
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
  const button = { join: 'Join', separate: 'Separate', rejoin: 'Remove', mute: 'Ignore', restore: 'Restore', forget: 'Delete data' }[intent]
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
    <p>{intent === 'forget' ? 'All data recorded for ' + subject + ' will be permanently deleted.' : intent === 'join' ? subject + ' and the other ID will be treated as one person.' : intent === 'separate' ? subject + ' and ' + other + ' will be treated as different people.' : intent === 'rejoin' ? subject + ' and ' + other + ' can be joined again.' : identifier}</p>
    <label>Reason <input name="reason" maxLength={1000}/></label>
    {intent === 'forget' && <>{!!targets?.length && <label><input type="checkbox" name="retract" value="yes"/> Ask {targets.join(', ')} to retract conversions</label>}<label><input type="checkbox" name="confirm" value="yes" required/> Permanently delete {subject}</label></>}
    <button type="submit" className={intent === 'forget' ? 'danger' : 'primary'} aria-disabled={busy} disabled={busy}>{busy ? 'Saving…' : button}</button>
    {!scope && <Answer result={fetcher.data}/>}
  </fetcher.Form></details>
}
