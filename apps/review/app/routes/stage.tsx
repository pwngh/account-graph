import { useEffect, useRef, useState } from 'react'
import { Link, useActionData, useFetcher, useLoaderData, useRevalidator, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import type { StageState } from '../../../../examples/firm/stage-state'
import stageStyle from '../../../../examples/firm/stage.css?url'
import { changeStage, loadStage } from '../stage.server'
import Accounts from '../views/accounts'
import { Report } from '../views/reports'
import { Remaining } from './remaining'
import { Answer, type ActionResult } from '../views/shared'

export const links = () => [{rel: 'stylesheet', href: stageStyle}]
export const loader = ({request}: LoaderFunctionArgs) => loadStage(request)
export const action = ({request}: ActionFunctionArgs) => changeStage(request)

function Fields({rows}: {rows: [string,string][]}) {
  return <>{rows.map(([label, value]) => <div className="field" key={label}><small>{label}</small> <span>{value}</span></div>)}</>
}

function Phone({state, phone}: {state: StageState, phone: string}) {
  const p = state.practice
  const shown = state.scenes[state.next - 1]?.shown
  const page = phone === 'ad' || phone === 'site' ? phone : phone.startsWith('text-') ? 'texts' : ['calling','missed','talking','director'].includes(phone) ? 'ringing' : 'paper'
  const text = phone === 'text-pay' ? p.texts.last.join(' ') : phone === 'text-time' ? 'Su llamada con M. Ortega es el miércoles a las 11:00.' : 'Tessaly: gracias por hablar con nosotros, Inés. Complete sus datos aquí.'
  const words = phone === 'paid' ? p.last.done : phone === 'signed' ? p.signed : phone === 'form-sent' ? ['Datos enviados','Gracias, Inés.'] : phone === 'pay' ? [p.last.title,p.last.text] : ['Sus datos','Esta página es de la firma.']
  return <aside id="stage-phone" aria-label="The caller’s phone"><div className="device" data-state={phone} data-page={page}><div className="screen">
    <div className="bar"><time>{new Date(state.clock).toISOString().slice(11,16)} UTC</time><i/></div>
    {page === 'ad' ? <div className="page ad"><div className="ask">{p.ask}</div><div className="result"><small>Anuncio · {p.firm}</small><b>{p.ad[0]}</b>{p.ad[1]}</div></div>
      : page === 'site' ? <div className="page site"><iframe src={state.site + '/es?phone=1'} title="The sample firm on the caller’s phone"/></div>
      : page === 'ringing' ? <div className="page ringing"><span className="face">T</span><b>{p.firm}</b><span className="how">{phone === 'missed' ? 'Missed call' : phone === 'calling' ? 'Calling…' : 'Answered'}</span><span className="clock">{shown?.seconds} s</span></div>
      : page === 'texts' ? <div className="page texts"><div className="with">{p.firm}</div><div className="thread"><p className="bubble">{text}</p></div></div>
      : <div className="page paper"><div className="sheet"><small>{p.firm}</small><b>{words[0]}</b><p>{words[1]}</p>{phone === 'form' && <Fields rows={p.form}/>}{phone === 'pay' && <Fields rows={p.last.fields}/>}</div></div>}
  </div></div><small><b>The caller’s phone</b> {shown?.caption || p.captions[phone] || ''}</small></aside>
}

export default function StagePage() {
  const {state: loaded, content, path, viewError} = useLoaderData<typeof loader>()
  const actionData = useActionData<ActionResult>()
  const [live, setLive] = useState(loaded)
  const state = live.revision > loaded.revision ? live : loaded
  const [status, setStatus] = useState('')
  const [playing, setPlaying] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [enhanced, setEnhanced] = useState(false)
  const fetcher = useFetcher<ActionResult>()
  const {revalidate} = useRevalidator()
  const run = useRef<HTMLButtonElement>(null)
  const restart = useRef<HTMLButtonElement>(null)
  const seen = useRef(loaded)
  const scene = state.scenes[state.next - 1]
  const phone = state.next === 0 ? 'ad' : scene?.shown?.phone
  const finished = state.next >= state.scenes.length
  const busy = state.running || fetcher.state !== 'idle'
  const desk = scene?.shown?.desk
  const card = state.told.card
  const currentView = loaded.boot === state.boot && loaded.next === state.next && state.ready
  useEffect(() => {
    setEnhanced(true)
    if (!window.EventSource) return
    const stream = new EventSource('/events?stage=1')
    stream.addEventListener('stage', e => {
      const before = seen.current
      const update = {...before, ...JSON.parse(e.data)} as StageState
      seen.current = update
      setLive(update)
      setStatus('')
      if (update.ready && !update.running && (!before.ready || before.running || before.next !== update.next || before.boot !== update.boot)) void revalidate()
    })
    stream.addEventListener('signout', () => { stream.close(); location.replace('/signin') })
    stream.onerror = () => setStatus('Stage connection interrupted. Reconnecting…')
    return () => stream.close()
  }, [revalidate])
  useEffect(() => {
    document.body.classList.toggle('with-phone', Boolean(phone))
    return () => document.body.classList.remove('with-phone')
  }, [phone])
  useEffect(() => {
    if (!currentView || !scene) return
    if (!scene.spot) return
    const rows = [...document.querySelectorAll<HTMLElement>('#stage-view tr, #stage-view .timeline-entry, #stage-view li, #stage-view .inbox-call')]
    let index = -1
    for (const word of scene.spot) {
      index = rows.findIndex((row, i) => i > index && row.textContent?.includes(word))
      if (index < 0) break
    }
    const match = rows[index]
    match?.classList.add('spot')
    return () => match?.classList.remove('spot')
  }, [scene, currentView, content])
  const play = () => {
    if (playing) setPlaying(false)
    else if (state.next) setStatus('Press R to restart before playing the story.')
    else setPlaying(true)
  }
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement)?.closest('input, select, textarea, button, summary, a')) return
      switch (event.key.toLowerCase()) {
        case ' ': case 'space': event.preventDefault(); run.current?.click(); break
        case 'r': setPlaying(false); restart.current?.click(); break
        case 'p': play(); break
        case 'h': setHidden(h => !h); break
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  useEffect(() => {
    if (!playing || busy || !state.ready) return
    if (state.next >= 17 || fetcher.data?.error) { setPlaying(false); return }
    const timer = setTimeout(() => run.current?.click(), state.next ? 4800 : 0)
    return () => clearTimeout(timer)
  }, [playing, busy, state.next, state.ready, fetcher.data])
  return <div className={phone ? 'with-phone' : undefined}>{phone && <Phone state={state} phone={phone}/>}
    <section><h2>{scene?.title ?? state.practice.firm}</h2>{scene && <p>{scene.text}</p>}
      {!state.ready && <p role="status">Loading sample history · {state.progress}. <a href="/stage">Refresh progress</a></p>}
      {state.error && <p role="alert">{state.error}</p>}{state.ready && <Link to={path}>Open reviewer view</Link>}
    </section>
    {(card || desk) && <aside id="stage-desk" className="on"><strong>{card?.title || desk?.name}</strong><Fields rows={card?.fields || desk?.fields || []}/>{desk?.done} {state.told.checked && <small>{state.told.checked} POST /match</small>} {card?.path}</aside>}
    <div id="stage-view" key={state.boot + state.next}>{currentView && viewError && <p role="alert">{viewError} <a href="/stage">Retry view</a></p>}{currentView && content &&
      ('accounts' in content ? <Accounts data={content.accounts!}/> : 'report' in content ? <Report data={content.report!} openCard={scene?.open}/> : <Remaining model={content.other!}/>)}</div>
    {state.told.credit && <section className="stage-credit">Ad credit of contact:ines-vega <b>{Math.round(100 * state.told.credit.share)}%</b>{state.told.credit.campaign ? 'Credited to ' + state.told.credit.campaign : 'Not credited. It takes 90%.'}</section>}
    <div id="stage" role="group" aria-label="Demo scenes" className={hidden ? 'away' : undefined} data-at={state.next} data-ms={state.ms} data-ready={state.ready} data-running={busy}>
      <span className="where">{state.next} of {state.scenes.length}</span><b>{scene?.title ?? 'Scenes'}</b><span className="told" role="status">{status || (state.ready ? state.told.lines.join(' ') : state.progress)}</span>
      <fetcher.Form method="post" action="/stage" className="keys" preventScrollReset>
        {enhanced && <input type="hidden" name="_enhanced" value="1"/>}<input type="hidden" name="boot" value={state.boot}/><input type="hidden" name="expected" value={state.next}/>
        <button ref={run} name="intent" value="run" className="primary" hidden={finished} disabled={!state.ready || busy || finished}>Next <kbd>Space</kbd></button>
        {enhanced && <button type="button" onClick={play} disabled={!state.ready}>{playing ? 'Pause' : 'Play'} <kbd>P</kbd></button>}
        <button ref={restart} name="intent" value="restart" className={finished ? 'primary' : ''} disabled={busy || (!state.ready && !state.error)} onClick={() => setPlaying(false)}>Restart <kbd>R</kbd></button>
        {enhanced && <button type="button" onClick={() => setHidden(true)}>Hide <kbd>H</kbd></button>}
      </fetcher.Form><Answer result={fetcher.data ?? actionData}/>
    </div>{hidden && <button type="button" onClick={() => setHidden(false)}>Show scene controls</button>}
  </div>
}
