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

const landing = (lang: 'en' | 'es', graph: string) => {
  const words = {
    en: { title: 'Example & Partners', line: 'Three made-up offices: North, River and Online. Nobody here is a lawyer, and none of this is real.', call: 'Call (555) 010-0101', number: '+15550100101', other: '<a href="/es">En español</a>', note: 'From an ad, this page shows you a number of your own while it is open.' },
    es: { title: 'Example y Asociados', line: 'Tres oficinas inventadas: North, River y Online. Aquí nadie es abogado, y nada de esto es real.', call: 'Llame al (555) 010-0103', number: '+15550100103', other: '<a href="/">In English</a>', note: 'Si llega desde un anuncio, esta página le muestra un número propio mientras está abierta.' },
  }[lang]
  return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width"><title>${words.title}</title><style>${SHARED}</style>
<main><h1>${words.title}</h1><p>${words.line}</p><p><a class="call" data-ag-pool href="tel:${words.number}">${words.call}</a></p><p class="muted">${words.note}</p><p>${words.other}</p></main>
<script type="module" src="${graph}/collect.js?pool=1&params=office,lang"></script></html>`
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
<p class="muted">A made-up firm, two months of made-up history, nothing sent anywhere. Each scene does what the site, the phone system or the office would do, over HTTP. Press Space or the button for the next one, and open the view it changed.</p>
<p><button id="next">Next scene</button> <a id="review" href="${graph}/review" target="review">Open the reviewer screen</a> <span class="muted">(token: demo)</span></p>
<p id="problem" role="alert"></p><ol id="scenes"></ol></main>
<script>
const make = (tag, text, props = {}) => Object.assign(document.createElement(tag), { textContent: text ?? '', ...props })
const list = document.getElementById('scenes'), button = document.getElementById('next'), problem = document.getElementById('problem')
let at = 0
const draw = () => [...list.children].forEach((item, i) => { item.className = i < at ? 'done' : ''; if (i === at) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current') })
const ready = fetch('/scenes').then((answer) => answer.json()).then(({ next, scenes }) => {
  at = next
  for (const { title, text, see } of scenes) {
    const item = make('li'), body = make('div')
    body.append(make('h2', title), make('p', text, { className: 'muted' }))
    const told = make('div'), where = make('p')
    where.append(make('a', 'See it: ' + see[0], { href: see[1], target: 'review' }))
    body.append(told, where)
    item.append(body)
    item.told = told
    list.append(item)
  }
  draw()
  button.disabled = at >= scenes.length
})
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
  } catch (error) { problem.textContent = 'That scene did not run: ' + error.message }
  button.disabled = at >= list.children.length
}
button.addEventListener('click', run)
addEventListener('keydown', (event) => { if (event.code === 'Space' && !event.target.closest('a, button')) { event.preventDefault(); run() } })
</script></html>`

export const page = (which: 'en' | 'es' | 'present', graph: string): string => (which === 'present' ? presenter(graph) : landing(which, graph))
