/** The pages of the made-up firm's site, in two languages, and what the demo adds to the reviewer screen. */

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
.text { display: inline-flex; align-items: center; min-height: 52px; margin: 24px 0 0 18px; color: var(--accent); font-weight: 600; text-underline-offset: 3px; }
form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; max-width: 620px; margin-top: 16px; } form > :not(.half) { grid-column: 1 / -1; }
.received { margin-top: 10px; } label { display: grid; gap: 4px; font-size: 14px; } label.check { grid-template-columns: auto 1fr; gap: 8px; align-items: start; color: var(--muted); }
form input:not([type=checkbox]), textarea { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: inherit; font: inherit; } textarea { min-height: 84px; resize: vertical; }
form:not(:has([data-ag-for-other]:checked)) .theirs { display: none; }
button { justify-self: start; min-height: 46px; padding: 0 22px; border: 0; border-radius: 12px; background: var(--accent); color: var(--on); font: inherit; font-weight: 600; cursor: pointer; }
footer { border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; } footer .wrap { padding-block: 18px 28px; }
@media (max-width: 560px) { .hero .wrap { padding-block: 30px 34px; } .call { display: flex; } .text { display: flex; justify-content: center; margin: 4px 0 0; } section { padding: 30px 0; } }
`

/** The phone on the stage is light, whatever the presenter's computer is set to. */
const LIGHT = SITE.replace('color-scheme: light dark', 'color-scheme: light').replace(/@media \(prefers-color-scheme: dark\).*\n/, '')

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
    text: 'Text us', form: ['Write to us', 'First name', 'Last name', 'Phone', 'How can we help?', 'You may text me about my inquiry. Message and data rates may apply. Reply STOP to end texts.', 'Send', 'Received. We will call you back.', 'This is about somebody else.', 'Their first name', 'Their last name'],
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
    text: 'Envíe un texto', form: ['Escríbanos', 'Nombre', 'Apellido', 'Teléfono', '¿Cómo podemos ayudarle?', 'Pueden enviarme textos sobre mi consulta. Pueden aplicarse tarifas de mensajes y datos. Responda STOP para dejar de recibirlos.', 'Enviar', 'Recibido. Le llamaremos.', 'Es sobre otra persona.', 'Nombre de esa persona', 'Apellido de esa persona'],
    made: 'Firma ficticia. Datos de muestra. No es asesoría legal.',
  },
} satisfies Record<'en' | 'es', { help: [string, string[][]]; then: [string, string[][]]; where: [string, string[][]]; other: string[]; [word: string]: unknown }>

/** What an injury firm says in place of the above. */
const INJURY = {
  en: {
    title: 'Tessaly Injury Law', head: 'Hurt in an accident? Talk to someone today.', lead: 'Injury law for North, River and online clients, in English and Spanish.',
    help: ['How we help', [
      ['Car accidents', 'Drivers, passengers and pedestrians, and the insurance claims that follow.'],
      ['Truck accidents', 'Records kept, vehicles inspected and the company asked for its logs.'],
      ['Work injuries', 'What happened, who was responsible and what was reported.'],
    ]] as [string, string[][]],
  },
  es: {
    title: 'Tessaly Lesiones Personales', head: '¿Tuvo un accidente? Hable con nosotros hoy.', lead: 'Lesiones personales para clientes de North, River y en línea, en español y en inglés.',
    help: ['Cómo le ayudamos', [
      ['Accidentes de auto', 'Conductores, pasajeros y peatones, y los reclamos al seguro.'],
      ['Accidentes de camión', 'Se guardan los registros, se inspeccionan los vehículos y se piden las bitácoras.'],
      ['Lesiones en el trabajo', 'Qué pasó, quién fue responsable y qué se reportó.'],
    ]] as [string, string[][]],
  },
}

/** A landing page. In the phone of the stage the scenes say what happens, so it reports nothing, has no form, and its call button tells the stage. */
export const landing = (lang: 'en' | 'es', graph: string, phone = false, sent = false, practice: 'family' | 'injury' = 'family'): string => {
  const { title, head, lead, call, number, hours, other, help, then, where, text, form, made } = { ...WORDS[lang], ...(practice === 'injury' ? INJURY[lang] : {}) }
  const [write, first, last, tel, helped, agree, send, received, elses, theirFirst, theirLast] = form
  const asked = `<section id="write"><div class="wrap"><h2>${write}</h2>${sent ? `<p class="received" role="status">${received}</p>` : `<form action="/inquiry" method="post" data-ag-fields><input type="hidden" name="lang" value="${lang}"><label class="half">${first}<input name="first" autocomplete="given-name" maxlength="60" required></label><label class="half">${last}<input name="last" autocomplete="family-name" maxlength="60" required></label><label>${tel}<input name="phone" type="tel" autocomplete="tel" maxlength="30" required></label><label class="check"><input type="checkbox" name="about_other" value="yes" data-ag-for-other>${elses}</label><label class="half theirs">${theirFirst}<input name="their_first" autocomplete="off" maxlength="60"></label><label class="half theirs">${theirLast}<input name="their_last" autocomplete="off" maxlength="60"></label><label>${helped}<textarea name="about" maxlength="500"></textarea></label><label class="check"><input type="checkbox" name="texts" value="yes">${agree}</label><button>${send}</button></form>`}</div></section>`
  const list = (kind: string, [name, items]: [string, string[][]], tag = 'ul') => `<section><div class="wrap"><h2>${name}</h2><${tag} class="${kind}">${items.map(([what, text]) => `<li><div><h3>${what}</h3><p>${text}</p></div></li>`).join('')}</${tag}></div></section>`
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>${phone ? LIGHT : SITE}</style></head><body>
<header><div class="wrap"><a class="brand" href="${lang === 'es' ? '/es' : '/'}"><svg viewBox="0 0 26 26" aria-hidden="true"><rect width="26" height="26" rx="8"/><path d="M7 9h12M13 9v10M9.500 19h7"/></svg>${title}</a><a class="lang" lang="${other[1]}" hreflang="${other[1]}" href="${other[0]}">${other[2]}</a></div></header>
<main><div class="hero"><div class="wrap"><h1>${head}</h1><p>${lead}</p><a class="call" data-ag-pool href="tel:${number}">${call}</a>${phone ? '' : `<a class="text" data-ag-pool href="sms:${number}">${text}</a>`}<p class="hours">${hours}</p></div></div>
${list('grid', help)}${phone ? '' : asked}${list('steps', then, 'ol')}${list('grid', where)}</main>
<footer><div class="wrap">${made}</div></footer>
${phone ? `<script>addEventListener('click', (event) => { const link = event.target.closest('a'); if (!link) return; event.preventDefault(); if (link.matches('.call')) parent.postMessage('call', ${JSON.stringify(graph)}) })</script>` : `<script type="module" src="${graph}/collect.js?pool=1&params=office,lang"></script>`}</body></html>`
}

/** Runs first in the reviewer screen of the demo. Its time is the demo's, which the server says with every answer. */
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

