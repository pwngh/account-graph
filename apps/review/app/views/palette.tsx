import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useRevalidator } from 'react-router'
import { subjectAddress, subjectPath } from '../navigation'
import { ViewMark, type ViewName } from './marks'

/** IDs opened in this tab, newest first, as many as the original screen keeps. */
const RECENT = 'review-recent'
const recent = (): string[] => {
  try { return JSON.parse(sessionStorage.getItem(RECENT) ?? '[]') } catch { return [] }
}
function remember(subject: string) {
  try { sessionStorage.setItem(RECENT, JSON.stringify([subject, ...recent().filter(each => each !== subject)].slice(0, 8))) } catch { /* Storage may be off. */ }
}

/** Whether every letter typed is in a text, in order, and how well. Letters at the start of words and together score better. */
function matched(text: string, typed: string) {
  const [whole, part] = [text.toLowerCase(), typed.toLowerCase()]
  let at = -1, score = 0
  const places: number[] = []
  for (const letter of part) {
    const next = whole.indexOf(letter, at + 1)
    if (next < 0) return undefined
    score += next === at + 1 ? 3 : next === 0 || /[\s:.-]/.test(whole[next - 1]!) ? 2 : 0
    places.push(next)
    at = next
  }
  return { score: score - whole.length / 100, places }
}

type Item = { group: string, text: string, go: () => void, mark?: ViewName | '>', note?: string, found?: boolean }

/** The search palette of the original screen: IDs as they are typed, the views, Refresh, the IDs opened lately, and what can be done with the one open. Ctrl K or ⌘K. */
export function Palette({ views }: { views: [string, string, ViewName][] }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const { revalidate } = useRevalidator()
  const location = useLocation()
  const [typed, setTyped] = useState('')
  const [people, setPeople] = useState<Item[]>([])
  const [looking, setLooking] = useState(false)
  const [at, setAt] = useState(0)
  const open = subjectAddress(location.pathname)
  useEffect(() => { if (open) remember(open.subject) }, [open?.subject])
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      event.preventDefault()
      const box = dialog.current
      if (!box) return
      if (box.open) box.close()
      else { setAt(0); box.showModal(); input.current?.focus() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  // What is typed is looked up a moment after the last key, and an answer to older words is dropped.
  useEffect(() => {
    setPeople([])
    const text = typed.trim()
    if (!text) { setLooking(false); return }
    setLooking(true)
    const stop = new AbortController()
    const wait = setTimeout(async () => {
      try {
        const response = await fetch('/find', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: stop.signal })
        const { by, subjects } = response.ok ? await response.json() : { by: 'subject', subjects: [] }
        setPeople(subjects.map((subject: string) => ({ group: 'IDs', text: subject, found: true, note: by === 'subject' ? '' : 'by ' + (by === 'click' ? 'ad click' : by), go: () => navigate(subjectPath(subject)) })))
      } catch { /* Stopped, or the graph did not answer: nothing is listed. */ }
      if (!stop.signal.aborted) setLooking(false)
    }, 160)
    return () => { stop.abort(); clearTimeout(wait) }
  }, [typed, navigate])
  const close = () => { dialog.current?.close(); setTyped(''); setPeople([]) }
  const actions: Item[] = open ? [location.pathname.startsWith('/accounts') ? { group: open.subject, text: 'Open journey', mark: '>', go: () => navigate(subjectPath(open.subject, 'journey')) } : { group: open.subject, text: 'Open account', mark: '>', go: () => navigate(subjectPath(open.subject)) }] : []
  const commands: Item[] = [...actions, ...views.map(([path, title, mark]): Item => ({ group: 'Go to', text: title, mark, go: () => navigate('/' + path) })), { group: 'Go to', text: 'Refresh', go: () => void revalidate() }]
  const lately = recent().map((subject): Item => ({ group: 'Recent', text: subject, go: () => navigate(subjectPath(subject)) }))
  const text = typed.trim()
  const some = [...people, ...(text ? lately.filter(each => !people.some(person => person.text === each.text)) : []), ...commands, ...(text ? [] : lately)]
  const held = some.map(item => ({ ...item, match: text && !item.found ? matched(item.text, text) : { score: 99, places: [] as number[] } })).filter((item): item is Item & { match: { score: number, places: number[] } } => Boolean(item.match))
  const groups = [...new Set(held.map(item => item.group))]
  const shown = groups.flatMap(group => held.filter(item => item.group === group).sort((x, y) => (text ? y.match.score - x.match.score : 0)))
  const picked = Math.min(at, Math.max(0, shown.length - 1))
  const choose = (i: number) => { const item = shown[i]; if (!item) return; close(); item.go() }
  return <dialog id="palette" aria-label="Search" ref={dialog} onClose={() => { setTyped(''); setPeople([]) }} onClick={event => { if (event.target === dialog.current) close() }}>
    <div className="palette-top"><i className="glass" aria-hidden="true"/><input ref={input} type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-label="Search" placeholder="Search IDs or go to…" autoComplete="off" spellCheck={false}
      aria-activedescendant={shown.length ? 'palette-' + picked : undefined} value={typed} onChange={event => { setTyped(event.target.value); setAt(0) }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setAt((picked + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length))
        else if (event.key === 'Enter') choose(picked)
        else return
        event.preventDefault()
      }}/><kbd>esc</kbd></div>
    <div id="palette-list" role="listbox" aria-label="Results">
      {shown.length === 0 ? <p className="muted palette-none">{looking ? 'Searching…' : 'No results'}</p> : groups.map(group => <div role="group" aria-label={group} key={group}><p className="inbox-age">{group}</p>
        {shown.filter(item => item.group === group).map(item => {
          const i = shown.indexOf(item)
          return <div key={group + item.text} id={'palette-' + i} className="palette-item" role="option" aria-selected={i === picked} title={item.text} onClick={() => choose(i)} onPointerMove={() => { if (picked !== i) setAt(i) }}>
            <i className="palette-mark">{item.mark === '>' ? '›' : item.mark ? <ViewMark name={item.mark}/> : null}</i>
            <span>{[...item.text].map((letter, n) => item.match.places.includes(n) ? <mark key={n}>{letter}</mark> : letter)}</span>
            {item.note && <span className="meta">{item.note}</span>}
          </div>
        })}</div>)}
    </div>
    <div className="palette-foot"><span><kbd>Up</kbd><kbd>Down</kbd></span>to navigate<span><kbd>Enter</kbd></span>to open</div>
  </dialog>
}
