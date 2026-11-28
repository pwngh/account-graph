import { setImmediate as yieldToStage } from 'node:timers/promises'
import { hashPhone, nameKeys, recordCall } from '../../tools/internals.ts'
import type { Graph } from '../../tools/internals.ts'
import type { Practice } from './practice.ts'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const SECRET = 'a-demo-secret-that-protects-nothing'

/** Where the firm's site is, as its visits are recorded. The site of the demo itself runs on this machine. */
export const ADDRESS = 'https://www.firm.example.org'
/** The firm's campaigns, named as an agency would: the office, the area of law, and what kind of campaign it is. */
export const campaignsOf = ({ area }: Pick<Practice, 'area'>) => ({
  north: `North | ${area} | Search`, river: `River | ${area} | Search`, spanish: `North | ${area} | Búsqueda`, online: `Online | ${area} | Consultations`, listing: `River | ${area} | Map listing`,
})
/** The firm's own numbers, each with where it is published. */
export const linesOf = (names: ReturnType<typeof campaignsOf>) => ({
  '+15550100101': { source: 'google', campaignId: '30111', campaign: names.north, tags: { office_advertised: 'north', language: 'en' } },
  '+15550100102': { source: 'google', campaignId: '30222', campaign: names.river, tags: { office_advertised: 'river', language: 'en' } },
  '+15550100103': { source: 'google', campaignId: '30333', campaign: names.spanish, tags: { office_advertised: 'north', language: 'es' } },
  '+15550100104': { source: 'listing', medium: 'map', campaign: names.listing, tags: { office_advertised: 'river', language: 'es' } },
  '+15550100105': { source: 'meta', campaignId: '40444', campaign: names.online, tags: { office_advertised: 'online', language: 'en' } },
})
const adsOf = (names: ReturnType<typeof campaignsOf>) => [
  { source: 'google', campaignId: '30111', campaign: names.north, office: 'north', lang: 'en', line: '+15550100101', daily: 84, share: 0.34, client: 0.16 },
  { source: 'google', campaignId: '30222', campaign: names.river, office: 'river', lang: 'en', line: '+15550100102', daily: 61, share: 0.24, client: 0.11 },
  { source: 'google', campaignId: '30333', campaign: names.spanish, office: 'north', lang: 'es', line: '+15550100103', daily: 38, share: 0.24, client: 0.2 },
  { source: 'meta', campaignId: '40444', campaign: names.online, office: 'online', lang: 'en', line: '+15550100105', daily: 45, share: 0.18, client: 0.06 },
] as const
export const stepsOf = ({ papers, won, value }: Practice): Record<string, { value: number; currency: string; wait?: number; action?: { google: string } }> => ({
  call: { value: 5, currency: 'USD', action: { google: '222' } },
  inquiry: { value: 10, currency: 'USD', wait: 48, action: { google: '111' } },
  intake: { value: 20, currency: 'USD' },
  [papers]: { value: 40, currency: 'USD' },
  scheduled: { value: 60, currency: 'USD' },
  [won]: { value, currency: 'USD', action: { google: '333' } },
})
const FIRST = ['Ana', 'Luis', 'Maria', 'Jorge', 'Elena', 'Pat', 'Sam', 'Robin', 'Lee', 'Dana', 'Alex', 'Noor']
const LAST = ['Rivera', 'Santos', 'Moreno', 'Hill', 'Stone', 'Brook', 'Vale', 'Cruz', 'Marsh', 'Field']

/** Keeps what a person is called, as a `profile` or a `call` would, for the sample history that is written without them. */
export type Keep = (subject: string, at: number, said: { name?: string; phone?: string }) => Promise<void>

/** Uses the same generator for the historical sample and for the offices that keep working between scenes. */
export function firmHistory(kind: Practice, clock: () => number, writeAt: (at: number | undefined) => void, quick: boolean, say: (line: string) => void | Promise<void>) {
  const names = campaignsOf(kind)
  const CAMPAIGNS = adsOf(names)
  const STEPS = stepsOf(kind)
  const calls = { numbers: linesOf(names), results: 'expected' as const }
  let seed = 20261124
  const chance = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff
  const pick = <T>(list: readonly T[]): T => list[Math.floor(chance() * list.length)]!
  const phoneOf = (n: number) => `+1555010${String(1000 + n).slice(-4)}`

  const spentOn = new Set<string>()
  /** What every campaign cost on a day. The one for online consultations has a week with no costs recorded. */
  async function spend(graph: Graph, at: number, ago = 0) {
    const day = new Date(at).toISOString().slice(0, 10)
    if (spentOn.has(day)) return
    spentOn.add(day)
    await graph.spend(CAMPAIGNS.filter(({ campaignId }) => !(campaignId === '40444' && ago >= 10 && ago < 17)).map(({ source, campaignId, campaign, daily }) => {
      const amount = Math.round(daily * kind.cost * (0.8 + chance() * 0.4) * 100) / 100
      return { day, source, campaignId, campaign, amount, currency: 'USD', clicks: Math.round(amount / 4), impressions: Math.round(amount * 12) }
    }))
  }
  let others = 0
  /** Somebody else arrives from an ad, rings and is answered, so the feeds are as alive as they would be. */
  async function other(graph: Graph, rang: number, keep: Keep = async () => {}) {
    const { lang, line, office, source, campaignId, campaign } = pick(CAMPAIGNS)
    writeAt(rang)
    await graph.touch({ subject: `visitor:d${others}`, at: rang, source, medium: 'cpc', campaignId, campaign, [source === 'google' ? 'gclid' : 'fbclid']: `d${others}`, landing: `${ADDRESS}${lang === 'es' ? '/es' : '/'}`, custom: { office, lang } })
    const from = phoneOf(2000 + ++others)
    await recordCall(graph, { id: `day-${rang}`, from, to: line, at: rang, duration: 120 + Math.floor(chance() * 600), answered: true, tags: { language: lang } }, { ...calls, now: clock, convert: (outcome) => graph.outcome({ ...outcome, value: STEPS.call!.value, currency: 'USD' }) })
    await keep(`caller:${hashPhone(from)}`, rang, { phone: from })
  }
  const known = new Set<string>()
  /** A contact called after a made-up person, and a number where there are several. */
  const contactOf = (first: string, last: string) => {
    const name = `contact:${first}-${last}`.toLowerCase()
    let id = name
    for (let n = 2; known.has(id); n++) id = `${name}-${n}`
    known.add(id)
    return id
  }

  /** Two months of a firm's life. */
  async function fill(graph: Graph, keep: Keep = async () => {}) {
    const start = clock()
    writeAt(start)
    for (let ago = 59; ago >= 0; ago--) await spend(graph, start - ago * DAY, ago)
    const people = quick ? 40 : 320
    for (let n = 0; n < people; n++) {
      if (n % 16 === 0) {
        await say(`${n} of ${people} people`)
        // A long chain of already resolved memory writes would keep the stage from receiving progress.
        await yieldToStage()
      }
      let roll = chance()
      const campaign = CAMPAIGNS.find(({ share }) => (roll -= share) < 0) ?? CAMPAIGNS[0]
      const { source, campaignId, office, lang, line } = campaign
      // Most come by day, on weekdays a little more.
      const at = Math.min(start - Math.floor((1 + chance() * 3) * HOUR), Math.floor((start - chance() * 58 * DAY) / DAY) * DAY + Math.floor((14 + chance() * 11) * HOUR))
      const visitor = `visitor:s${n}`
      const from = phoneOf(n)
      writeAt(at)
      await graph.observe({ subject: visitor, identifiers: [`device:s${n}`, `ip:198.51.100.${n % 200}`], at, event: 'visit' })
      await graph.touch({ subject: visitor, at, source, medium: 'cpc', campaignId, campaign: campaign.campaign, [source === 'google' ? 'gclid' : 'fbclid']: `s${n}`, landing: `${ADDRESS}${lang === 'es' ? '/es' : '/'}`, custom: { office, ...(chance() < 0.85 && { lang }) } })
      const called = chance() < 0.62
      let reached = !called
      let met = at
      if (called) {
        const rang = at + Math.floor(1 + chance() * 40) * 60_000
        const roll = chance()
        const answered = roll < 0.74
        const call = { from, to: line, duration: answered ? 120 + Math.floor(chance() * 900) : 20 + Math.floor(chance() * 80), waited: Math.floor(chance() * 60), ...(chance() < 0.8 && { tags: { language: lang } }) }
        writeAt(rang)
        await recordCall(graph, { id: `s${n}`, at: rang, answered, ...(roll > 0.9 && { voicemail: true }), ...call }, { ...calls, now: clock, convert: (outcome) => graph.outcome({ ...outcome, value: STEPS.call!.value, currency: 'USD' }) })
        await keep(`caller:${hashPhone(from)}`, rang, { phone: from })
        reached = answered
        met = rang + (call.duration + call.waited) * 1000
        // Staff call back the same day, and again on the next ones until somebody picks up.
        for (let tries = 0, back = rang; !reached && tries < 4; tries++) {
          back += Math.floor(1 + chance() * (tries === 0 ? 5 : 7)) * HOUR
          if (back >= start) break
          writeAt(back)
          reached = tries === 2 || chance() < 0.75
          met = back + 300_000
          await recordCall(graph, { id: `b${n}-${tries}`, direction: 'outbound', from: line, to: from, at: back, duration: reached ? 300 : 25, answered: reached }, { ...calls, now: clock })
        }
      }
      if (!reached || chance() > 0.55) continue
      // They left their number, with staff or in a form, and staff opened a contact for them.
      const asked = met + Math.floor(chance() * 20) * HOUR
      if (asked > start) continue
      const name = [pick(FIRST), pick(LAST)] as const
      const contact = contactOf(...name)
      writeAt(asked)
      await graph.observe({ subject: contact, identifiers: [...(called ? [] : [`device:s${n}`]), `phone:${hashPhone(from)}`, `email:made-up-${n}`, ...nameKeys(SECRET, ...name, { dob: `19${60 + (n % 40)}-0${1 + (n % 9)}-1${n % 9}` })], at: asked, event: 'inquiry' })
      await keep(contact, asked, { name: name.join(' '), phone: from })
      if (called) await graph.joinAll([{ a: `caller:${hashPhone(from)}`, b: contact, reason: 'answered by staff' }], { by: 'system:desk' })
      if (called) await graph.observe({ subject: contact, identifiers: [`device:s${n}`], at: asked, event: 'inquiry' })
      const step = async (stage: string, moment: number, value: number = STEPS[stage]!.value) => {
        const when = Math.floor(moment)
        if (when > start) return false
        writeAt(when)
        // Some go to the office that is nearest, whatever the ad said.
        const office_served = chance() < 0.18 ? pick(['north', 'river', 'online']) : office
        await graph.outcome({ transactionId: `${stage}-${n}`, subject: contact, at: when, stage, value, currency: 'USD', tags: { office_served, ...(chance() < 0.8 && { language: lang }) } })
        return true
      }
      if (!(await step('inquiry', asked)) || (chance() > 0.6 && start - asked < 30 * HOUR)) continue
      // They fill in the form, sign, and are scheduled, some not as far.
      let moment = asked
      let reachedAll = true
      for (const [stage, least, most, share] of [['intake', 0.02, 0.5, 1], [kind.papers, 0.02, 0.4, 0.92], ['scheduled', 0.05, 0.6, 0.95]] as const) {
        moment += (least + chance() * (most - least)) * DAY
        if (chance() > share || !(await step(stage, moment))) {
          reachedAll = false
          break
        }
      }
      if (!reachedAll || chance() > campaign.client * 2.2) continue
      const signed = Math.floor(moment + (2 + chance() * 24) * DAY)
      if (!(await step(kind.won, signed))) continue
      // What was collected came later: less from some, more from others, nothing from a few.
      const settled = signed + (4 + chance() * 12) * DAY
      if (settled < start) {
        writeAt(Math.floor(settled))
        await graph.restate(`${kind.won}-${n}`, chance() < 0.15 ? 0 : Math.round((250 + chance() * 1400) * (kind.value / 400)))
      }
    }
    // Somebody has rung this morning too.
    await other(graph, start - 40 * 60_000, keep)
    writeAt(start)
    // Households: a phone on two contacts of two names, which the preset only relates.
    for (let n = 0; n < (quick ? 3 : 9); n++) {
      const phone = `phone:${hashPhone(phoneOf(900 + n))}`
      const [one, other] = [0, 1].map((side) => ({ subject: contactOf(FIRST[(n + side * 5) % FIRST.length]!, LAST[n % LAST.length]!), identifiers: [phone, `email:home-${n}-${side}`, ...nameKeys(SECRET, FIRST[(n + side * 5) % FIRST.length]!, LAST[n % LAST.length]!, { dob: `19${70 + n}-03-1${side}` })], at: start - (n + 2) * HOUR, event: 'staff entry' }))
      await graph.observe([one!, other!])
      for (const side of [0, 1]) await keep([one!, other!][side]!.subject, start, { name: `${FIRST[(n + side * 5) % FIRST.length]} ${LAST[n % LAST.length]}`, phone: phoneOf(900 + n) })
    }
    writeAt(undefined)
    await say(`${people} of ${people} people`)
  }

  return { spend, other, fill }
}
