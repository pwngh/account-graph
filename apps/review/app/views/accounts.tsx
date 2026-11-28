import { Fragment, useEffect, useRef, useState } from 'react'
import { Form, Link, useLocation, useSearchParams } from 'react-router'
import { subjectPath } from '../navigation'
import { amount, Author, Badge, type Called, CalledContext, Compare, DecisionForm, knownOf, Reasons, type Reason, DecisionScope, PageHead, percent, Scroll, shownPhone, Subject, Table, Tiles, Time, type WriteContext, CallerId } from './shared'
import { ICONS, nameOf, PERSON, typeOf, type ClusterLayout } from './cluster-layout.js'
import { Guide } from './guide'
import { seenAs } from './report-words.js'
import { Term } from './terms'

type Dates = Record<string, { firstSeen?: number, createdAt?: number }>
interface Tie { subject: string, level: 'same' | 'related', score: number, reasons: Reason[] }
interface Decision { seq: number, action: string, at: number, about: string[], by?: string, reason?: string }
export interface KnownProfile {
  subject: string, known: true, dates?: Dates
  cluster: { id: string, members: string[], oversized: boolean, limitedByCalls?: boolean }
  links: Tie[], separated: string[], apart: [string, string][], edges: { a: string, b: string, score: number, level: string }[]
  verdicts: { a: string, b: string, last: Decision, apart?: Decision, reversals: number }[]
  flows: { subject: string, relation: string, sent: number, received: number, asset: string, count: number, last: number }[]
  rings: { subjects: string[], amount: number, asset: string, tied: number }[]
  consent: { at: number, adUserData: boolean, adPersonalization: boolean, source?: string, recorded: number }[]
  history: { at: number, identifier: string, event?: string }[]
}
export type ProfilePage = Omit<KnownProfile, 'cluster' | 'apart' | 'edges'> & {
  cluster: { oversized: boolean, limitedByCalls?: boolean }
  memberCount: number, linkCount: number, separatedCount: number, strongest: number, listedMembers: string[], start: number
  /** The values each column can be narrowed to, with how many rows have each, and how many rows are left. */
  filters: { links: Record<string, [string, number][]>, sightings: Record<string, [string, number][]>, shown: number, seen: number, total: number }
}
export type Profile = ProfilePage | { subject: string, known: false, dates?: Dates }
export interface AccountsData {
  subject?: string, profile?: Profile, layout?: ClusterLayout, key: string, at: number, offset?: number, author?: string
  /** What each person the page lists is called, by ID. */
  called?: Record<string, Called>
  /** What the person wrote, the newest first: form messages and inbound texts. */
  wrote?: readonly { from: 'lead' | 'text', id: string, subject: string, at: number, text: string, cut: boolean }[]
  /** The same record in the firm's own system, where the firm has said how its addresses are made. */
  link?: { href: string, host: string }
  clusters: { id: string, size: number, oversized?: boolean }[]
  recent: { subject: string, to?: string, at: number }[]
  decisions: { decisions: Decision[], total: number, next: number | null }
  audit: { sound: boolean, head?: { seq: number } | null, brokenAt?: number | null }
  retraction?: { targets: string[], always: boolean }
}

export function ClusterGraph({ layout }: { layout: ClusterLayout }) {
  const [off, setOff] = useState<string[]>([])
  const [score, setScore] = useState(0)
  const [ready, setReady] = useState(false)
  const [selected, setSelected] = useState('')
  const [camera, setCamera] = useState({ zoom: 1, dx: 0, dy: 0 })
  const diagram = useRef<HTMLDivElement>(null)
  const back = useRef<Element | null>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const drag = useRef<{ x: number, y: number, dx: number, dy: number, scale: number } | null>(null)
  const [left, top, width, height] = layout.viewBox.split(' ').map(Number)
  const zoom = (factor: number) => setCamera(view => ({ ...view, zoom: Math.min(8, Math.max(.5, view.zoom * factor)) }))
  const viewBox = [left + width / 2 - width / (2 * camera.zoom) + camera.dx, top + height / 2 - height / (2 * camera.zoom) + camera.dy, width / camera.zoom, height / camera.zoom].join(' ')
  const node = layout.nodes.find(node => node.id === selected)
  const close = () => {
    setSelected('')
    if (back.current?.isConnected) (back.current as SVGElement).focus({preventScroll:true})
  }
  useEffect(() => { if (selected) closeButton.current?.focus({preventScroll:true}) }, [selected])
  useEffect(() => setReady(true), [])
  const kinds = { joined: 'Same person', related: 'Related', apart: 'Separated' }
  const visible = layout.paths.filter(edge => !off.includes(edge.kind) && (edge.kind === 'apart' || (edge.score ?? 0) * 100 >= score))
  return <><div className="graph" ref={diagram} onKeyDown={event => {
    if (event.key === 'Escape' && node) { event.preventDefault(); close() }
  }}><div className="stage"><svg viewBox={viewBox} role="group" aria-label="Cluster graph" tabIndex={ready ? 0 : undefined}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return
      const moves: Record<string, [number,number]> = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }
      const move = moves[event.key]
      if (!move) return
      event.preventDefault()
      setCamera(view => ({ ...view, dx: view.dx + move[0] * width / (8 * view.zoom), dy: view.dy + move[1] * height / (8 * view.zoom) }))
    }}
    onPointerDown={event => {
      if (event.button !== 0 || (event.target as Element).closest('a')) return
      const scale = event.currentTarget.getScreenCTM()?.a
      if (!scale) return
      drag.current = { x: event.clientX, y: event.clientY, dx: camera.dx, dy: camera.dy, scale }
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={event => {
      const start = drag.current
      if (start) setCamera(view => ({ ...view, dx: start.dx - (event.clientX - start.x) / start.scale, dy: start.dy - (event.clientY - start.y) / start.scale }))
    }}
    onLostPointerCapture={() => { drag.current = null }}><g>
    <g>{layout.hulls.map((d, i) => <path className="mine" key={i} d={d} strokeWidth={28}/>)}</g>
    <g>{visible.map(edge => <g key={JSON.stringify([edge.a, edge.b])} className={'edge ' + edge.kind}><title>{edge.a + ' and ' + edge.b + ' · ' + edge.label}</title><path className="line" d={edge.d} strokeWidth={1 + 2 * (edge.score ?? 0)}/></g>)}</g>
    <g>{visible.length <= 9 && visible.map(edge => <g className={'tag worded ' + edge.kind} key={JSON.stringify([edge.a, edge.b])} transform={'translate(' + edge.x + ' ' + edge.y + ')'}><rect x={-4 * edge.label.length - 4} y="-10" width={8 * edge.label.length + 8} height="20" rx="10"/><text textAnchor="middle" y="4">{edge.label}</text></g>)}</g>
    <g>{layout.nodes.map(node => <a key={node.id} className={'node ' + node.role} href={subjectPath(node.id)} onClick={event => {
      if (!ready || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      back.current = event.currentTarget
      setSelected(node.id)
    }} aria-label={node.id + ', ' + ({ me: 'this subject', member: 'same person', apart: 'kept apart', related: 'related' }[node.role] || node.role)}><g transform={'translate(' + node.x + ' ' + node.y + ')'}><title>{node.id}</title><circle className="halo" r={node.r + 7}/><circle className="disc" r={node.r}/><path className={ICONS[typeOf(node.id)] ? 'icon line' : 'icon'} d={ICONS[typeOf(node.id)] || PERSON} transform={'scale(' + node.r / 15 + ')'}/>{node.role === 'apart' && <path className="no" d={'M' + -node.r * .71 + ' ' + node.r * .71 + 'L' + node.r * .71 + ' ' + -node.r * .71}/>}<text className="name" textAnchor="middle" x={node.tx} y={node.ty - 2}>{nameOf(node.id)}</text><text className="type" textAnchor="middle" x={node.tx} y={node.ty + 13}>{typeOf(node.id)}</text></g></a>)}</g>
  </g></svg>{node && <aside className="card" aria-label={node.id}><button ref={closeButton} className="shut" aria-label="Close" type="button" onClick={close}>×</button><b className="title">{node.id}</b><p>{{ me: 'Selected ID', member: 'Same person', related: 'Related', apart: 'Separated' }[node.role] || 'Indirect'}</p>
    {layout.paths.filter(line => line.a === node.id || line.b === node.id).map(line => <div key={JSON.stringify([line.a,line.b])} className="reason"><b>{line.a === node.id ? line.b : line.a}</b> · {line.label}</div>)}
    <div className="row"><Link className="button primary" to={subjectPath(node.id)}>Open</Link><Link className="button" to={subjectPath(node.id) + '#links'}>Show links</Link></div></aside>}</div><div className="bar"><div className="keys">{Object.entries(kinds).map(([kind, name]) => {
    const count = layout.paths.filter(edge => edge.kind === kind).length
    return count > 0 && (ready ? <button type="button" className={kind} key={kind} aria-pressed={!off.includes(kind)} onClick={() => setOff(off.includes(kind) ? off.filter(k => k !== kind) : [...off, kind])}><svg viewBox="0 0 22 8" aria-hidden="true" focusable="false"><line x1="2" y1="4" x2="20" y2="4"/></svg>{name}<span className="count">{count}</span></button> : <span key={kind}>{name} {count} </span>)
  })}{ready && <label className="least"><input aria-label="Minimum score, in percent" type="range" min="0" max="100" step="5" value={score} onChange={event => setScore(Number(event.target.value))}/><span>{score ? 'Score ≥ ' + score + '%' : 'All scores'}</span></label>}</div>{ready && <div className="tools"><button type="button" aria-label="Zoom in" onClick={() => zoom(1.25)}>+</button><button type="button" aria-label="Zoom out" onClick={() => zoom(.8)}>−</button><button type="button" aria-label="Reset the layout" onClick={() => {
    setCamera({ zoom: 1, dx: 0, dy: 0 })
    setOff([])
    setScore(0)
    setSelected('')
  }}>Reset</button>{document.fullscreenEnabled && <button type="button" onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : diagram.current?.requestFullscreen())?.catch(() => {})}>Full screen</button>}</div>}</div></div>{layout.total > 24 && <p className="muted">Showing 24 of {amount(layout.total)}. All links are listed below.</p>}</>
}

function DatesOf({ id, dates }: { id: string, dates?: Dates }) {
  if (/^(visitor|caller|call):/.test(id)) return null
  const { firstSeen, createdAt } = dates?.[id] ?? {}
  return <>{firstSeen != null && <div className="meta">First seen here <Time at={firstSeen}/></div>}{createdAt != null && <div className="meta">Created in your system <Time at={createdAt}/></div>}</>
}

/** The heading of an account: the person's name, else their number, else the whole ID, which is never shortened here. */
const headed = (subject: string, called?: Called) => called?.name ?? (called?.phone ? shownPhone(called.phone) : subject)

/**
 * The bar over a table that narrows its rows, as on the original screen: each value chosen shows as a chip to take away, and + Filter
 * lists the values of each column with how many rows have them. It is a set of links, so it works without scripts, and the address keeps it.
 */
function FilterBar({ label, columns, names, words, shown, total, hash }: { label: string, columns: Record<string, [string, number][]>, names: Record<string, string>, words: string, shown: number, total: number, hash: string }) {
  const [query] = useSearchParams()
  const { pathname } = useLocation()
  const menu = 'filter-' + label.toLowerCase()
  // A narrower table starts at its first page.
  const href = (name: string, value?: string) => { const q = new URLSearchParams(query); q.delete('links'); if (value === undefined) q.delete(name); else q.set(name, value); return pathname + (q.size ? '?' + q : '') + hash }
  const chosen = Object.entries(names).flatMap(([column, name]) => query.get(name) ? [[column, name, query.get(name)!] as const] : [])
  const typed = query.get(words) ?? ''
  // The words go in an ordinary form, so Enter narrows the table with or without scripts, and the other values chosen stay.
  return <div className="filter-bar" role="search" aria-label={'Filter ' + label.toLowerCase()}>
    <Form method="get" action={pathname + hash} preventScrollReset className="filter-words-form">{[...query].filter(([name]) => name !== words && name !== 'links').map(([name, value]) => <input key={name} type="hidden" name={name} value={value}/>)}<input type="search" className="filter-words" name={words} defaultValue={typed} placeholder={'Filter ' + label.toLowerCase()} aria-label={'Filter ' + label.toLowerCase()}/></Form>
    <span className="filter-chips">{chosen.map(([column, name, value]) => <Link key={name} className="filter-chip button" to={href(name)} aria-label={'Remove ' + column + ' ' + value} preventScrollReset><span>{column}</span>{value}<i aria-hidden="true">×</i></Link>)}
      {(chosen.length > 0 || typed) && <Link className="filter-clear" to={[...Object.values(names), words].reduce((path, name) => { const q = new URLSearchParams(path.split('?')[1]?.split('#')[0]); q.delete(name); return pathname + (q.size ? '?' + q : '') }, href('links')) + hash} preventScrollReset>Clear</Link>}</span>
    <button type="button" className="filter-add" popoverTarget={menu}>+ Filter</button>
    {(chosen.length > 0 || typed) && <span className="meta" role="status">{amount(shown)} of {amount(total)}</span>}
    <div className="filter-menu" id={menu} popover="auto">{Object.entries(columns).filter(([, values]) => values.length > 0).map(([column, values]) => <fieldset key={column}><legend>{column}</legend>
      {[...values].sort(([x, n], [y, m]) => m - n || (x < y ? -1 : 1)).slice(0, 12).map(([value, n]) => <Link key={value} to={href(names[column]!, value)} aria-current={query.get(names[column]!) === value ? 'true' : undefined} preventScrollReset><span>{value}</span><span className="count">{amount(n)}</span></Link>)}</fieldset>)}</div>
  </div>
}

/** The four groups of the Links table, in order, each with the tone of its dot. */
const GROUPS: [string, string][] = [['Same person', 'same'], ['High confidence', 'same'], ['Related', 'related'], ['Separated', 'apart']]

function ProfileView({ profile, data, context }: { profile: Profile, data: AccountsData, context: WriteContext }) {
  const { subject, dates } = profile
  const [query] = useSearchParams()
  const { pathname } = useLocation()
  if (!profile.known) return <section><div className="page-head"><h2 className="page-title"><Badge id={subject}/><bdi title={subject}>{headed(subject, data.called?.[subject])}</bdi></h2><Guide view="accounts"/></div><DatesOf id={subject} dates={dates}/><p className="muted">No records</p></section>
  const members = new Set(profile.listedMembers)
  const consent = profile.consent[0]
  const verdicts = new Map(profile.verdicts.map(v => [v.a === subject ? v.b : v.a, v]))
  const count = profile.filters.shown
  const start = profile.start
  const pageHref = (offset: number) => { const q = new URLSearchParams(query); q.set('links', String(offset / 50)); return pathname + '?' + q + '#links' }
  const indices = Array.from({ length: Math.min(50, count - start) }, (_, i) => i)
  const [folded, setFolded] = useState<string[]>([])
  const statusAt = (i: number) => { const link = profile.links[i]; return !link ? 'Separated' : link.level === 'same' ? members.has(link.subject) ? 'Same person' : 'High confidence' : 'Related' }
  const scoresOf = (group: string) => indices.filter(i => statusAt(i) === group).flatMap(i => profile.links[i] ? [profile.links[i]!.score] : [])
  const range = (scores: number[]) => scores.length === 0 ? '' : percent(Math.min(...scores)) === percent(Math.max(...scores)) ? percent(Math.min(...scores)) : percent(Math.min(...scores)) + ' – ' + percent(Math.max(...scores))
  const linkFilters = { Status: 'status', Identifier: 'kind', Type: 'type' }
  const row = (i: number, away: boolean) => {
    const link = profile.links[i]
    const id = link?.subject ?? profile.separated[i - profile.links.length]
    const v = verdicts.get(id)
    const word = !link ? 'Separated' : link.level === 'same' ? members.has(id) ? 'Same person' : 'High confidence' : 'Related'
    return <tr key={word + id} className={away ? 'folded' : undefined}><td className="who"><Badge id={id}/><Subject id={id}/><DatesOf id={id} dates={dates}/></td><td><span className={'chip ' + (link?.level ?? 'apart')}>{word}</span>{(v?.reversals ?? 0) >= 3 && <span className="chip apart">Conflict</span>}</td><td className="num score edge">{link ? <Compare share={link.score}>{percent(link.score)}</Compare> : <span className="muted">—</span>}</td><td className="why">{link ? <Reasons reasons={link.reasons} context={context} subject={subject}/> : v?.apart ? <><Author by={v.apart.by}/> · <Time at={v.apart.at} now={data.at}/> {v.apart.reason}{v.last.action === 'join' && <p>Later joined by <Author by={v.last.by}/>, <Time at={v.last.at} now={data.at}/>. The separation takes precedence.</p>}</> : <span className="muted">No data</span>}</td>
      <td className="edge"><DecisionForm context={context} subject={subject} other={id} intent={link ? 'separate' : 'rejoin'}/>{/* A join a reviewer made can be taken back, which is not the same as saying the two are different people. */}{link && v?.last.action === 'join' && !v.apart && <DecisionForm context={context} subject={subject} other={id} intent="unjoin" look="link"/>}</td></tr>
  }
  const sightingFilters = { Event: 'event', Identifier: 'seen' }
  return <><section><div className="page-head"><h2 className="page-title"><Badge id={subject}/><bdi title={subject}>{headed(subject, data.called?.[subject])}</bdi></h2><Guide view="accounts"/><div className="row">{data.link && <a className="button" href={data.link.href} target="_blank" rel="noopener noreferrer">Open in {data.link.host}</a>}<Link className="button" to={subjectPath(subject, 'journey')}>Journey</Link><DecisionForm context={context} subject={subject} intent="join" label="Join with…"/><DecisionForm context={context} subject={subject} intent="forget" label="Delete…" targets={data.retraction?.always ? undefined : data.retraction?.targets}/></div></div>
  <p className="meta" id="known"><bdi>{knownOf(subject, data.called?.[subject])}</bdi></p>
  {(data.called?.[subject]?.dob || data.called?.[subject]?.address || data.called?.[subject]?.line) && <p className="meta" id="born"><bdi>{[LINE_WORDS[data.called[subject].line ?? ''], data.called[subject].dob && 'Born ' + data.called[subject].dob, data.called[subject].address].filter(Boolean).join(' · ')}</bdi></p>}<p className="meta"><CallerId id={subject}/></p>
    <DatesOf id={subject} dates={dates}/><Tiles items={[
      [['Linked IDs', 'linkedIds'], amount(profile.memberCount), profile.cluster.oversized && 'Above review limit'],
      profile.linkCount > 0 && [['Strongest link', 'strongest'], percent(profile.strongest), amount(profile.linkCount) + (profile.linkCount === 1 ? ' link' : ' links')],
      profile.separatedCount > 0 && [['Separated', 'separated'], amount(profile.separatedCount)],
      profile.history.length > 0 && [['Last seen', 'lastSeen'], <Time at={profile.history.reduce((top, row) => Math.max(top, row.at), 0)} now={data.at}/>],
      !!consent && [['Ad consent', 'consent'], consent.adUserData && consent.adPersonalization ? 'Granted' : consent.adUserData || consent.adPersonalization ? 'Partial' : 'Denied', consent.source]
    ]}/>{profile.cluster.limitedByCalls && <p className="banner">Several call histories fit this group. Some possible matches have been kept apart.</p>}{profile.cluster.oversized && <p className="banner"><b>Large group.</b> A widely shared identifier may be joining different people. Review the links below.</p>}
  </section>{data.layout && (data.layout.paths.length > 0 || profile.separatedCount > 0) && <section><h2><Term id="graph"/></h2><ClusterGraph key={subject} layout={data.layout}/></section>}
  <section id="links"><h2><Term id="links"/></h2>{profile.linkCount + profile.separatedCount > 5 && <FilterBar label="Links" columns={profile.filters.links} names={linkFilters} words="words" shown={count} total={profile.linkCount + profile.separatedCount} hash="#links"/>}{count ? <Table title="Links" headers={['ID', 'Status', ['Score', 'num edge', 'score'], ['Evidence', '', 'evidence'], ['Action', 'edge']]}>{GROUPS.flatMap(([group, tone]) => {
    const rows = indices.filter(i => statusAt(i) === group)
    if (rows.length === 0) return []
    const away = folded.includes(group)
    return [<tr className="fold" key={'fold ' + group}><th scope="rowgroup" colSpan={5}><button type="button" aria-expanded={!away} onClick={() => setFolded(away ? folded.filter(each => each !== group) : [...folded, group])}><i className="chevron" aria-hidden="true"/><i className={'dot ' + tone} aria-hidden="true"/>{group}<span className="count">{amount(rows.length)}</span><span className="meta">{range(scoresOf(group))}</span></button></th></tr>, ...rows.map(i => row(i, away))]
  })}</Table> : <p className="muted">No links</p>}{start > 0 && <Link className="button" to={pageHref(start - 50)}>Previous links</Link>} {start + 50 < count && <Link className="button" to={pageHref(start + 50)}>Show more links</Link>}</section>
  {!!data.wrote?.length && <section id="wrote"><h2>Messages</h2><Table title="Messages" headers={['When', 'From', 'Message']}>{data.wrote.map(each => <tr key={each.from + ' ' + each.id}><td><Time at={each.at}/></td><td>{each.from === 'lead' ? 'Form' : 'Text'}</td><td className="wrote">{each.text}{each.cut && <span className="muted"> (the rest was not kept)</span>}</td></tr>)}</Table></section>}
  {!!profile.flows.length && <section><h2><Term id="transfers"/></h2><Table title="Transfers" headers={['ID', 'Status', 'Sent', 'Received', 'Transfers', 'Last']}>{profile.flows.map((flow, i) => <tr key={i}><td><Subject id={flow.subject}/></td><td>{flow.relation === 'none' ? 'Not linked' : flow.relation === 'same' ? 'Same person' : 'Related'}</td><td>{amount(flow.sent)} {flow.asset}</td><td>{amount(flow.received)} {flow.asset}</td><td>{amount(flow.count)}</td><td><Time at={flow.last} short/></td></tr>)}</Table>{!!profile.rings.length && <><h2><Term id="rings"/></h2><ul>{profile.rings.map((ring, i) => <li key={i}>{ring.subjects.map(id => <Fragment key={id}><Subject id={id}/> → </Fragment>)}{subject} · {amount(ring.amount)} {ring.asset} {ring.tied > 0 && (ring.tied + ' linked to this ID')}</li>)}</ul></>}</section>}
  <div className="panel-grid profile-grid">{!!profile.consent.length && <section><h2>Ad consent</h2><Table title="Ad consent" headers={['Date', 'Ad measurement', 'Ad personalization', 'Source', 'Recorded', 'Status']}>{profile.consent.map((c, i) => <tr key={i}><td><Time at={c.at || undefined} short/></td><td>{c.adUserData ? 'Granted' : 'Denied'}</td><td>{c.adPersonalization ? 'Granted' : 'Denied'}</td><td>{c.source || 'No data'}</td><td><Time at={c.recorded} short/></td><td>{i === 0 && 'Current'}</td></tr>)}</Table></section>}
  <section id="sightings"><h2><Term id="sightings"/><span className="count">{amount(profile.filters.total)}</span></h2>{profile.filters.total > 8 && <FilterBar label="Sightings" columns={profile.filters.sightings} names={sightingFilters} words="saw" shown={profile.filters.seen} total={profile.filters.total} hash="#sightings"/>}{profile.history.length ? <Table title="Sightings" headers={['Date', 'Event', 'Identifier']}>{profile.history.map((row, i) => <tr key={i}><td><Time at={row.at} short/></td><td>{row.event}</td><td title={row.identifier}>{seenAs(row.identifier)}</td></tr>)}</Table> : <p className="muted">No sightings</p>}</section></div></>
}

/** The kind of line a phone lookup found, as staff say it. A landline cannot be texted, and an app's number is weaker evidence of who somebody is. */
const LINE_WORDS: Record<string, string> = { mobile: 'Mobile number', landline: 'Landline', fixedVoip: 'Internet phone line', nonFixedVoip: 'Number from a calling app' }
const ACTIONS: Record<string, string> = { ignore: 'Ignored identifier', restore: 'Restored identifier', separate: 'Separated', rejoin: 'Removed separation', join: 'Joined', unjoin: 'Removed join', forget: 'Deleted data', rebuild: 'Rebuilt all groups', prune: 'Deleted sightings before' }
export default function Accounts({ data }: { data: AccountsData }) {
  return <CalledContext.Provider value={data.called ?? {}}><AccountsPage data={data}/></CalledContext.Provider>
}

function AccountsPage({ data }: { data: AccountsData }) {
  const { audit, clusters, recent, decisions, subject, profile } = data
  const first = clusters[0]
  const context = { key: data.key, at: data.at, seen: audit.head?.seq ?? 0 }
  const { pathname, search } = useLocation()
  const offset = data.offset || 0
  const latest = new Set<string>()
  return <DecisionScope key={pathname + search + '/' + (subject || 'list')}><div className={'split' + (subject ? ' opened' : '')}><aside className="account-rail"><section><h2><Term id="largest"/></h2><Scroll label="Largest groups"><ul id="queue">{clusters.length ? clusters.map(cluster => <li className="line" key={cluster.id}><Badge id={cluster.id}/><Subject id={cluster.id}/> <span className="muted">{amount(cluster.size)} IDs</span>{cluster.oversized && <span className="chip apart">Review</span>}</li>) : <li className="muted">None</li>}</ul></Scroll>{offset > 0 && <Link className="button" to={pathname + '?offset=' + Math.max(0, offset - 50)}>Previous groups</Link>} {clusters.length === 50 && <Link className="button" to={pathname + '?offset=' + (offset + 50)}>Show more</Link>}</section>
  <section><h2>Recent changes</h2><Scroll label="Recent changes"><ul id="recent">{recent.length ? recent.slice(0, 30).map((row, i) => <li className="move" key={i}><Badge id={row.subject}/><Subject id={row.subject}/> <span className="meta move-time"><Time at={row.at} now={data.at}/></span><span className="move-to">{row.to === undefined ? 'removed' : row.to === row.subject ? 'ungrouped' : <>joined <Subject id={row.to}/></>}</span></li>) : <li className="muted">None</li>}</ul></Scroll></section>
  <section><div className="section-head"><h2><Term id="audit"/></h2><Form className="row" action={pathname} method="get"><label className="sr-only" htmlFor="audit-author">Author</label><select id="audit-author" name="author" defaultValue={data.author ?? ''}><option value="">All</option><option value="people">People</option><option value="system">Systems</option></select><button>Show</button></Form></div><p className="meta">{audit.sound ? amount(decisions.total) + (decisions.total === 1 ? ' entry' : ' entries') + ' · Verified' : 'Altered at entry ' + audit.brokenAt}</p><Scroll label="Audit log"><ul id="decisions">{decisions.decisions.length ? decisions.decisions.map(d => {
    const first = !data.author && !latest.has(d.about[0])
    if (d.action === 'restore' || d.action === 'ignore') latest.add(d.about[0])
    return <li key={d.seq}><b>{ACTIONS[d.action] || d.action}</b><span className="reason">{d.about.map((id: string, i: number) => <Fragment key={i}>{i > 0 && ' · '}<bdi>{id}</bdi></Fragment>)}</span><div className="meta decision-by"><Author by={d.by}/> · <Time at={d.at} now={data.at}/>{d.reason && ': ' + d.reason}</div>{first && d.action === 'ignore' && <DecisionForm context={context} subject={subject ?? ''} intent="restore" identifier={d.about[0]} label="Undo" look="link"/>}</li>
  }) : <li className="muted">None</li>}</ul></Scroll>{decisions.next != null && <Link className="button" to={pathname + '?before=' + decisions.next + (data.author ? '&author=' + encodeURIComponent(data.author) : '')}>Show older</Link>}</section></aside>
  <div id="detail">{subject && profile ? <ProfileView key={subject} profile={profile} data={data} context={context}/> : <><section><PageHead view="accounts" title="Accounts"/><Tiles items={[[['Largest group', 'largest'], first ? amount(first.size) + ' IDs' : 'None', first?.oversized && 'Above review limit'], recent.length > 0 && ['Last change', <Time at={recent[0].at} now={data.at}/>], [['Audit log', 'record'], audit.sound ? 'Verified' : 'Altered', amount(context.seen) + (context.seen === 1 ? ' entry' : ' entries')]]}/></section>{first && data.layout && <section><div className="section-head"><h2>Largest group</h2><Subject id={first.id}/></div><ClusterGraph key={first.id} layout={data.layout}/></section>}</>}</div></div></DecisionScope>
}
