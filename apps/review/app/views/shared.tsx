import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, useFetcher } from 'react-router'
import { ICONS, PERSON, typeOf } from './cluster-layout.js'

export const amount = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
export const percent = (n: number) => Math.round(n * 100) + '%'
export const subjectPath = (subject: string, view = 'accounts') => '/' + view + '/' + encodeURIComponent(subject)
const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })
export const stamp = (at: number) => formatter.format(at) + ' UTC'
export function Time({ at }: { at?: number }) {
  if (at == null || !Number.isFinite(at)) return <>No data</>
  const exact = new Date(at).toISOString()
  return <time dateTime={exact} title={exact}>{stamp(at)}</time>
}

export function Subject({ id, journey = false }: { id: string, journey?: boolean }) {
  return <Link className="subject" to={subjectPath(id, journey ? 'journey' : 'accounts')}>{id}</Link>
}

export function Badge({ id }: { id: string }) {
  const kind = typeOf(id)
  return <svg className={'badge ' + (['account', 'visitor', 'lead', 'caller', 'contact', 'person'].includes(kind) ? kind : '')} viewBox="-11 -11 22 22" aria-hidden="true"><circle r="10"/><path className={ICONS[kind] ? 'line' : ''} d={ICONS[kind] || PERSON} transform="scale(.82)"/></svg>
}

export function Table({ title, headers, children }: { title: string, headers: string[], children: ReactNode }) {
  return <div className="wide" tabIndex={0} role="region" aria-label={title}><table><thead><tr>{headers.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>
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
      const next = control.current?.isConnected ? control.current : result.current
      next?.focus({ preventScroll: true })
    }
  }, [fetcher.data, fetcher.state])
  return <decisionKey.Provider value={{ key, enhanced, remember: element => { control.current = element } }}><div ref={result} tabIndex={-1}><Answer result={fetcher.data}/></div>{children}</decisionKey.Provider>
}

export interface WriteContext { key: string, at: number, seen: number }
export type Intent = 'join' | 'separate' | 'rejoin' | 'mute' | 'restore' | 'forget'
export function DecisionForm({ context, intent, subject, other, identifier, targets, label }: { context: WriteContext, intent: Intent, subject: string, other?: string, identifier?: string, targets?: string[], label?: string }) {
  const id = useId()
  const scope = useContext(decisionKey)
  const fetcher = useFetcher<ActionResult>({ key: scope?.key })
  const busy = fetcher.state !== 'idle'
  const button = { join: 'Join', separate: 'Separate', rejoin: 'Remove', mute: 'Ignore', restore: 'Restore', forget: 'Delete data' }[intent]
  return <details className="decision-form"><summary>{label || button}</summary><fetcher.Form method="post" preventScrollReset onSubmit={event => {
    if (busy) event.preventDefault()
    else scope?.remember(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  }}>
    {scope?.enhanced && <input type="hidden" name="_enhanced" value="1"/>}
    {Object.entries({ intent, key: context.key + id, seen: context.seen, at: context.at, subject, other, identifier }).map(([name, value]) => value != null && <input key={name} type="hidden" name={name} value={value}/>)}
    {intent === 'join' && !other && <label>Other ID <input name="other" placeholder="account:42" required maxLength={500}/></label>}
    <p>{intent === 'forget' ? 'All data recorded for ' + subject + ' will be permanently deleted.' : intent === 'join' ? subject + ' and the other ID will be treated as one person.' : intent === 'separate' ? subject + ' and ' + other + ' will be treated as different people.' : intent === 'rejoin' ? subject + ' and ' + other + ' can be joined again.' : identifier}</p>
    <label>Reason <input name="reason" maxLength={1000}/></label>
    {intent === 'forget' && <>{!!targets?.length && <label><input type="checkbox" name="retract" value="yes"/> Ask {targets.join(', ')} to retract conversions</label>}<label><input type="checkbox" name="confirm" value="yes" required/> Permanently delete {subject}</label></>}
    <button type="submit" className={intent === 'forget' ? 'danger' : 'primary'} aria-disabled={busy} disabled={busy}>{busy ? 'Saving…' : button}</button>
    {!scope && <Answer result={fetcher.data}/>}
  </fetcher.Form></details>
}
