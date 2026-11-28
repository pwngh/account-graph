import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { subjectPath } from '../navigation'
import { amount, Badge, CalledContext, DecisionForm, DecisionScope, Meter, PageHead, percent, Reasons, Subject, Tiles, Time, useNamed, type Called, type Reason, type WriteContext } from './shared'
import { Term } from './terms'

/** A pair as a row of the queue has it: who, how strong, and the kinds of what they share. */
export interface Pair { a: string, b: string, score: number, level: 'same' | 'related', kinds: string }
/** What is known of one of the two, as the comparison shows it. */
export interface Side { subject: string, kinds: string[], events: string[], first?: number, last?: number, sightings: number, members: number, separated: number }
export interface MatchesModel {
  view: 'decide', legacy?: string, context: WriteContext
  queue: { pairs: Pair[], total: number, seen: number, window?: { kind: string, older?: boolean, oldest?: number } }
  at: number, reasons?: Reason[], sides?: [Side, Side], effect?: string
  /** What each person in the queue is called, by ID. */
  called?: Record<string, Called>
}

export const pairName = ({ a, b }: { a: string, b: string }) => a + '\n' + b
const pairPath = (pair: Pair) => '/decide?' + new URLSearchParams({ pair: pairName(pair) })

/** A score as a ring around its number. */
function Dial({ score }: { score: number }) {
  const round = 2 * Math.PI * 26
  return <svg className="dial" viewBox="0 0 64 64" role="img" aria-label={percent(score)}><circle cx="32" cy="32" r="26"/><circle className="part" cx="32" cy="32" r="26" strokeDasharray={(round * score).toFixed(1) + ' ' + round.toFixed(1)}/><text x="32" y="37" textAnchor="middle">{percent(score)}</text></svg>
}

/** What is known of two IDs, line by line beside each other, with what they have alike brought forward. */
function Versus({ left, right, pair }: { left: Side, right: Side, pair: Pair }) {
  const chips = (mine: string[], theirs: string[]) => mine.length === 0 ? <span className="muted">No data</span> : [...mine].sort((x, y) => Number(theirs.includes(y)) - Number(theirs.includes(x))).map(each => <span key={each} className={'chip ' + (theirs.includes(each) ? 'alike' : 'muted')}>{each.replaceAll('_', ' ')}</span>)
  const seen = (side: Side) => side.sightings === 0 || side.first == null || side.last == null ? <span className="muted">No data</span> : <><Time at={side.first} short/> – <Time at={side.last} short/><span className="reason">{amount(side.sightings)} {side.sightings === 1 ? 'sighting' : 'sightings'}</span></>
  const who = (side: Side) => <div className="versus-who"><Badge id={side.subject}/><b><Subject id={side.subject}/></b><Link className="link" to={subjectPath(side.subject, 'journey')}>Journey</Link></div>
  const rows: [string, React.ReactNode, React.ReactNode][] = [
    ['Identifiers', chips(left.kinds, right.kinds), chips(right.kinds, left.kinds)],
    ['Events', chips(left.events, right.events), chips(right.events, left.events)],
    ['Active', seen(left), seen(right)],
    ['Linked IDs', amount(left.members), amount(right.members)],
    ['Separated from', left.separated ? amount(left.separated) : 'None', right.separated ? amount(right.separated) : 'None'],
  ]
  return <div className="versus" role="table" aria-label="Comparison">
    <div className="versus-row head" role="row"><div role="columnheader">{who(left)}</div><div className="versus-score" role="columnheader"><Dial score={pair.score}/><span className="meta">{pair.kinds}</span></div><div role="columnheader">{who(right)}</div></div>
    {rows.map(([name, one, two]) => <div className="versus-row" role="row" key={name}><div role="cell">{one}</div><div className="versus-name" role="rowheader">{name}</div><div role="cell">{two}</div></div>)}</div>
}

/** Pairs that share something and were not joined, one at a time, strongest first. */
export function Matches({ model }: { model: MatchesModel }) {
  return <CalledContext.Provider value={model.called ?? {}}><MatchesPage model={model}/></CalledContext.Provider>
}

function MatchesPage({ model }: { model: MatchesModel }) {
  const named = useNamed()
  const { queue, context, sides, reasons = [] } = model
  const pair = queue.pairs[model.at]
  const deck = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // J joins, K separates and S skips, as the keys beside the buttons say. A key typed into a field is text.
    function key(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.target as Element).closest?.('input, textarea, select, [contenteditable]')) return
      deck.current?.querySelector<HTMLElement>('.choices [aria-keyshortcuts="' + event.key.toLowerCase() + '"]')?.click()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const groups: [string, string, Pair[]][] = [['High confidence', 'confident', queue.pairs.filter(each => each.level === 'same')], ['Possible', 'possible', queue.pairs.filter(each => each.level !== 'same')]]
  const next = queue.pairs[(model.at + 1) % queue.pairs.length]
  return <DecisionScope key={pair ? pairName(pair) : 'none'}><section><PageHead view="decide" title="Matches"/><Tiles items={[[['Pending', 'pending'], amount(queue.total)], [['IDs checked', 'checked'], amount(queue.seen)]]}/>
    {queue.total > queue.pairs.length && <p className="meta">The strongest {amount(queue.pairs.length)} are listed. The rest follow as these are decided.</p>}
    {queue.window?.kind === 'recent' && queue.window.older && <p className="meta older">Pairs among sightings before <Time at={queue.window.oldest}/> are not in this queue. {model.legacy ? <a href={model.legacy}>Check older records on the original reviewer screen</a> : 'Check older records on the original reviewer screen'}.</p>}</section>
    {pair && sides ? <div className="deck" ref={deck}><div className="queue-rail scroll" tabIndex={0} role="region" aria-label="Queue">{groups.map(([name, term, list]) => list.length > 0 && <div key={name}><p className="inbox-age"><Term id={term}>{name}</Term><span className="count">{amount(list.length)}</span></p>
      {list.slice(0, 40).map(each => <Link key={pairName(each)} className="queue-pair" aria-current={each === pair ? 'true' : undefined} to={pairPath(each)} preventScrollReset><span className="queue-names"><span title={each.a}>{named(each.a)}</span><span title={each.b}>{named(each.b)}</span></span><b>{percent(each.score)}</b><span className="meta">{each.kinds}</span><Meter share={each.score}/></Link>)}
      {list.length > 40 && <p className="meta queue-more">{amount(list.length - 40)} more</p>}</div>)}</div>
      <section className="pair" aria-label="Pair"><div className="pair-top"><span className={'chip ' + pair.level}>{pair.level === 'same' ? 'High confidence' : 'Possible'}</span><span className="meta">{amount(model.at + 1)} of {amount(queue.pairs.length)}</span></div>
        <Versus left={sides[0]} right={sides[1]} pair={pair}/>
        <div className="pair-why"><p className="inbox-age"><Term id="evidence"/></p><Reasons reasons={reasons} context={context} subject={pair.a}/></div>
        <p className="pair-effect" role="status">{model.effect}</p>
        <div className="choices"><DecisionForm context={context} intent="join" subject={pair.a} other={pair.b} look="primary" keys="j"/><DecisionForm context={context} intent="separate" subject={pair.a} other={pair.b} keys="k"/>{next !== pair && <Link className="button choice" to={pairPath(next)} aria-keyshortcuts="s" preventScrollReset>Skip<kbd>S</kbd></Link>}</div></section></div>
      : <section><p className="muted">No pending matches</p></section>}</DecisionScope>
}
