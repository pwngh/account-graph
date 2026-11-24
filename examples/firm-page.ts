/** The pages of the made-up firm's site: its landing pages in two languages, and the page a presenter works from. */

const SHARED = `
:root { color-scheme: light dark; --ink: #1b1b1a; --muted: #66645e; --line: #e4e2dc; --bg: #fbfbfa; --accent: #1f4fd8; --on: #fff; --good: #0b6e4f; }
@media (prefers-color-scheme: dark) { :root { --ink: #e9e8e3; --muted: #a3a098; --line: #31302c; --bg: #141413; --accent: #8fb0ff; --on: #10131c; --good: #4cc79b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 780px; margin: 0 auto; padding: 24px 16px 60px; }
h1 { font-size: 22px; line-height: 1.3; margin: 0 0 4px; }
a { color: var(--accent); }
.muted { color: var(--muted); }
button, .call { display: inline-block; font: inherit; border: 1px solid var(--accent); border-radius: 4px; padding: 6px 14px; background: var(--accent); color: var(--on); text-decoration: none; cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`

const SITE = `
:root { color-scheme: light dark; --ink: #1a1a19; --muted: #61615e; --line: rgb(0 0 0 / .09); --bg: #fbfbfa; --card: #fff; --tint: #eef2fb; --accent: #2456c4; --on: #fff; }
@media (prefers-color-scheme: dark) { :root { --ink: #efefed; --muted: #a3a3a0; --line: rgb(255 255 255 / .1); --bg: #161615; --card: #1f1f1e; --tint: #1a2233; --accent: #7aa7ff; --on: #0b0b0c; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 400 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
h1, h2, h3, p, ul, ol { margin: 0; } ul, ol { padding: 0; list-style: none; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 6px; }
.wrap { max-width: 960px; margin: 0 auto; padding: 0 20px; }
header .wrap { display: flex; gap: 12px; align-items: center; justify-content: space-between; min-height: 60px; }
.brand { display: flex; gap: 10px; align-items: center; font-weight: 600; letter-spacing: -.01em; text-decoration: none; }
.brand svg { width: 26px; height: 26px; }
.brand rect { fill: var(--accent); } .brand path { fill: none; stroke: var(--on); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.lang { color: var(--muted); font-size: 14px; text-underline-offset: 3px; }
.hero { background: var(--tint); }
.hero .wrap { padding-block: 44px 46px; }
h1 { max-width: 15em; font-size: clamp(30px, 6vw, 46px); line-height: 1.12; font-weight: 650; letter-spacing: -.028em; text-wrap: balance; }
.hero p { max-width: 34em; margin-top: 14px; color: var(--muted); font-size: 17px; text-wrap: pretty; }
.call { display: inline-flex; gap: 10px; align-items: center; justify-content: center; min-height: 52px; margin-top: 24px; padding: 0 24px; border-radius: 12px; background: var(--accent); color: var(--on); font-size: 17px; font-weight: 600; text-decoration: none; font-variant-numeric: tabular-nums; }
.call::before { content: ""; width: 17px; height: 17px; background: currentColor; -webkit-mask: var(--phone) center / contain no-repeat; mask: var(--phone) center / contain no-repeat; --phone: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.4 1.5h2.3l1.2 3.1-1.6 1.2c.8 1.7 2.2 3.1 3.9 3.9l1.2-1.6 3.1 1.2v2.3c0 1-.8 1.8-1.8 1.7C6.500 12.900 3.100 9.500 1.700 3.300 1.600 2.300 2.400 1.500 3.400 1.500Z'/%3E%3C/svg%3E"); }
.call:active { transform: translateY(1px); }
.hero .hours { margin-top: 12px; font-size: 14px; }
section { padding: 38px 0; } section + section { border-top: 1px solid var(--line); }
h2 { font-size: 21px; letter-spacing: -.018em; font-weight: 600; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; margin-top: 16px; }
.grid li { padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); }
h3 { font-size: 16px; font-weight: 600; letter-spacing: -.008em; } .grid p, .steps p { margin-top: 4px; color: var(--muted); font-size: 15px; }
.steps { display: grid; gap: 16px; margin-top: 16px; counter-reset: step; }
.steps li { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; counter-increment: step; }
.steps li::before { content: counter(step); display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--tint); color: var(--accent); font-size: 14px; font-weight: 600; }
footer { border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; } footer .wrap { padding-block: 18px 28px; }
@media (max-width: 560px) { .hero .wrap { padding-block: 30px 34px; } .call { display: flex; } section { padding: 30px 0; } }
`

const WORDS = {
  en: {
    title: 'Tessaly Family Law', head: 'Divorce, custody and support. Talk to someone today.',
    lead: 'Family law for North, River and online clients, in English and Spanish.',
    call: 'Call (555) 010-0101', number: '+15550100101', hours: 'Monday to Friday, 8 AM to 6 PM.', other: ['/es', 'es', 'Español'],
    help: ['How we help', [
      ['Divorce', 'Agreed or contested, with the house, the accounts and the debts settled in writing.'],
      ['Custody', 'Schedules, decisions and changes to an order that no longer fits.'],
      ['Support', 'Child and spousal support: setting it, changing it and collecting it.'],
    ]],
    then: ['What happens when you call', [
      ['You reach intake', 'We ask what happened, who is involved and what is due next.'],
      ['We check for conflicts', 'We never speak with both sides of one matter.'],
      ['You meet an attorney', 'In person, by phone or by video. If we miss your call, we call you back.'],
    ]],
    where: ['Offices', [['North', 'In person and by phone.'], ['River', 'In person and by phone.'], ['Online', 'By video, anywhere in the state.']]],
    made: 'Fictional firm. Sample data. Not legal advice.',
  },
  es: {
    title: 'Tessaly Derecho Familiar', head: 'Su familia es lo primero. Hable con nosotros hoy.',
    lead: 'Derecho familiar para clientes de North, River y en línea, en español y en inglés.',
    call: 'Llame al (555) 010-0103', number: '+15550100103', hours: 'De lunes a viernes, de 8 a 18 h.', other: ['/', 'en', 'English'],
    help: ['Cómo le ayudamos', [
      ['Divorcio', 'De mutuo acuerdo o en disputa, con la casa, las cuentas y las deudas resueltas por escrito.'],
      ['Custodia', 'Horarios, decisiones y cambios a una orden que ya no funciona.'],
      ['Manutención', 'De los hijos o del cónyuge: fijarla, modificarla y cobrarla.'],
    ]],
    then: ['Qué pasa cuando llama', [
      ['Le atiende admisiones', 'Preguntamos qué pasó, quiénes participan y qué plazo sigue.'],
      ['Revisamos conflictos', 'Nunca hablamos con las dos partes de un mismo asunto.'],
      ['Se reúne con un abogado', 'En persona, por teléfono o por video. Si perdemos su llamada, se la devolvemos.'],
    ]],
    where: ['Oficinas', [['North', 'En persona y por teléfono.'], ['River', 'En persona y por teléfono.'], ['En línea', 'Por video, en todo el estado.']]],
    made: 'Firma ficticia. Datos de muestra. No es asesoría legal.',
  },
} satisfies Record<'en' | 'es', { help: [string, string[][]]; then: [string, string[][]]; where: [string, string[][]]; other: string[]; [word: string]: unknown }>

const landing = (lang: 'en' | 'es', graph: string) => {
  const { title, head, lead, call, number, hours, other, help, then, where, made } = WORDS[lang]
  const list = (kind: string, [name, items]: [string, string[][]], tag = 'ul') => `<section><div class="wrap"><h2>${name}</h2><${tag} class="${kind}">${items.map(([what, text]) => `<li><div><h3>${what}</h3><p>${text}</p></div></li>`).join('')}</${tag}></div></section>`
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>${SITE}</style></head><body>
<header><div class="wrap"><a class="brand" href="${lang === 'es' ? '/es' : '/'}"><svg viewBox="0 0 26 26" aria-hidden="true"><rect width="26" height="26" rx="8"/><path d="M7 9h12M13 9v10M9.500 19h7"/></svg>${title}</a><a class="lang" lang="${other[1]}" hreflang="${other[1]}" href="${other[0]}">${other[2]}</a></div></header>
<main><div class="hero"><div class="wrap"><h1>${head}</h1><p>${lead}</p><a class="call" data-ag-pool href="tel:${number}">${call}</a><p class="hours">${hours}</p></div></div>
${list('grid', help)}${list('steps', then, 'ol')}${list('grid', where)}</main>
<footer><div class="wrap">${made}</div></footer>
<script type="module" src="${graph}/collect.js?pool=1&params=office,lang"></script></body></html>`
}

const presenter = (graph: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width"><title>Presenter</title><style>${SHARED}
ol { list-style: none; margin: 20px 0; padding: 0; counter-reset: scene; }
li { counter-increment: scene; border-top: 1px solid var(--line); padding: 10px 0; display: grid; grid-template-columns: 28px minmax(0, 1fr); }
li::before { content: counter(scene); color: var(--muted); font-variant-numeric: tabular-nums; }
h2 { font-size: 15px; line-height: 1.5; margin: 0; }
li p { margin: 2px 0; overflow-wrap: anywhere; }
li.done h2::after { content: " · done"; color: var(--good); font-weight: 400; }
li .told { border-left: 2px solid var(--good); padding-left: 10px; }
#problem:not(:empty) { border-left: 2px solid #b3261e; padding-left: 10px; }
</style><main><h1>Presenter</h1>
<p class="muted">Sample firm with two months of data. Each scene sends the HTTP requests of the site, phone system or office. Press Space to run the next scene.</p>
<p><button id="next" disabled>Next scene</button> <a id="review" href="${graph}/review" target="review">Reviewer screen</a> <span class="muted">(token: demo)</span></p>
<p id="problem" role="alert"></p><ol id="scenes"></ol></main>
<script>
const make = (tag, text, props = {}) => Object.assign(document.createElement(tag), { textContent: text ?? '', ...props })
const list = document.getElementById('scenes'), button = document.getElementById('next'), problem = document.getElementById('problem')
let at = 0
const draw = () => [...list.children].forEach((item, i) => { item.className = i < at ? 'done' : ''; if (i === at) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current') })
fetch('/scenes').then((answer) => answer.json()).then(({ next, scenes }) => {
  at = next
  for (const { title, text, see } of scenes) {
    const item = make('li'), body = make('div')
    body.append(make('h2', title), make('p', text, { className: 'muted' }))
    const told = make('div'), where = make('p')
    where.append(make('a', 'Open ' + see[0], { href: see[1], target: 'review' }))
    body.append(told, where)
    item.append(body)
    item.told = told
    list.append(item)
  }
  draw()
  button.disabled = at >= scenes.length
}).catch((error) => { problem.textContent = 'Failed to load scenes: ' + error.message })
async function run() {
  if (button.disabled) return
  button.disabled = true
  problem.textContent = ''
  try {
    const answer = await fetch('/run', { method: 'POST' })
    const told = await answer.json()
    if (!answer.ok) throw new Error(told.error)
    const item = list.children[at]
    item.told.className = 'told'
    item.told.append(...told.lines.map((line) => make('p', line)), make('p', told.ms + ' ms', { className: 'muted' }))
    at += 1
    draw()
    list.children[at]?.scrollIntoView({ block: 'center' })
  } catch (error) { problem.textContent = 'Scene failed: ' + error.message }
  button.disabled = at >= list.children.length
}
button.addEventListener('click', run)
addEventListener('keydown', (event) => { if (event.code === 'Space' && !event.target.closest('a, button')) { event.preventDefault(); run() } })
</script></html>`

/** Runs first in the reviewer screen of the demo: its time is the demo's, which the server says with every answer. */
export const clockScript = (ahead: number): string => `(() => {
  let ahead = ${ahead}
  const Real = Date, real = fetch
  globalThis.Date = class extends Real { constructor(...of) { if (of.length) super(...of); else super(Real.now() + ahead) } static now() { return Real.now() + ahead } }
  globalThis.fetch = async (...of) => {
    const answer = await real(...of), told = answer.headers.get('x-demo-ahead')
    if (told !== null) ahead = Number(told)
    return answer
  }
})()`

export const page = (which: 'en' | 'es' | 'present', graph: string): string => (which === 'present' ? presenter(graph) : landing(which, graph))
