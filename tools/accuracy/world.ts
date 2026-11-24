/**
 * Makes up people, and what a firm's site, telephones and front desk would
 * report of them. Who is who is decided first, from people, and never from an
 * identifier. Nothing here is read from the graph: no import, weight, cap or
 * window of it. Addresses and emails are of ranges kept for examples, and
 * numbers of an area code nobody has.
 */
import type { Truth } from './score.ts'

/** How often things go as they do. Each is a share of what it says, unless it says otherwise. Sources are in `docs/accuracy.md`. */
export interface Rates {
  /** Of households, by how many adults: one, two, three, four. */
  adults: readonly [number, number, number, number]
  /** Households with a landline that any adult may call from. */
  landline: number
  /** Of calls from such a household, those made on the landline. */
  landlineUse: number
  /** Households of two adults or more where one computer is used by all. */
  sharedComputer: number
  /** Couples who share one email address. */
  sharedEmail: number
  /** People who go to the site on a computer as well as their telephone. */
  hasComputer: number
  /** Of visits, those on the computer, for who has one. */
  onComputer: number
  /** Telephone browsers that forget a page's own cookie after seven days without a visit. */
  forgets: number
  /** Browsers whose storage is cleared in a month, whatever they are. */
  clearedMonthly: number
  /** Of mobile visits, those on the carrier's network, where one address is many people's. */
  carrier: number
  /** People with a second email address they also give. */
  secondEmail: number
  /** People whose number changes in a year, and of the numbers given up, those whose next holder is another of these people. */
  numberChanges: number
  reusedHere: number
  /** Typing errors: an own email or telephone by its owner, and either by staff who heard it. Of them, those that come out as another of these people's. */
  typoMeets: number
  ownEmailTypo: number
  ownPhoneTypo: number
  staffEmailTypo: number
  staffPhoneTypo: number
  /** Of callers, those who hide their number. */
  hidden: number
  /** Of calls from a visit, those where the number is tapped and not dialed by hand, on a telephone and on a computer. */
  tapsTelephone: number
  tapsComputer: number
  /** Of people who become contacts, those another adult of the household speaks for: their number, or their email, is on the record. */
  spokenFor: number
  /** Records made twice: staff enter somebody who is there already. */
  duplicate: number
  /** A name, and a date of birth, written wrongly by its owner, and by staff who heard it. Who is asked for a date of birth. */
  nameTypo: number
  staffNameTypo: number
  birthTypo: number
  staffBirthTypo: number
  birthAsked: number
  /** Households of two or more where two were born on one day, and where two have one first name. */
  twins: number
  namesakes: number
  /** People with a short form of their first name, how often a record has it, and of them those whose short form begins with another letter. */
  hasShort: number
  shortGiven: number
  shortOtherInitial: number
  /** People whose surname changed. Half of their records have the new one. */
  surnameChanged: number
  /** People with two surnames, and how often a record has one of them only. */
  twoSurnames: number
  oneLeftOut: number
  /** Records that spell a name another way, as one alphabet does another's. Three in ten begin with another letter. */
  transliterated: number
  /** Calls with a record that staff join to it, and of them those joined to somebody else's. */
  staffJoins: number
  staffJoinsWrong: number
  /** Of calls again, those dialed from the list of calls made, and so on the number shown before. */
  redialed: number
  /** Of records and calls by one who speaks for another, those made on the speaker's own visit. */
  speakerVisits: number
  /** Visits on a telephone on which the number is tapped and no call made. */
  idleTap: number
  /** Callers who never visit, for each of these people: clients of before, referrals, vendors, the other side. Those staff make a record of. */
  cold: number
  coldRecorded: number
  /** More calls by the same caller, on average, dialed without a visit. */
  again: number
  /** Of people, those who visit and then do nothing else. */
  onlyVisit: number
  /** Chance that somebody who would not have does too, when another adult of the household has. */
  together: number
  /** Of those who do, who fills in the form, and who calls. Some do both. */
  form: number
  call: number
  /** Of calls, those a person answers; of calls and late records, those where staff ask for an email. */
  answered: number
  emailAsked: number
  /** Visits besides the first, on average. */
  visits: number
  /** What the third run added. Without it a world is what it was, draw for draw. */
  third?: Third
}

/** First names as a list has them, each with how common it is, the forms it is given in, and what it is called in English. */
export interface Names {
  english: readonly { name: string; share: number; shorts: readonly string[] }[]
  spanish: readonly { name: string; share: number; shorts: readonly string[]; english: readonly string[] }[]
  spanishShare: number
}

export interface Third {
  /** Of people with a short form, records that have it; of people with a name in English besides, records that have that. */
  shortGiven: number
  englishGiven: number
  /** Spanish names of two, and how often a record has one of the two only. */
  compound: number
  compoundHalved: number
  /** Records with first and last name swapped, records of somebody spoken for with the speaker's name, and households where two have names a letter apart. */
  swapped: number
  speakersName: number
  alike: number
  /** Of records where one speaks for another and staff made them, those staff say so of; of forms, those where the box is ticked. Of the client's own number and email, given beside. */
  staffTold: number
  formTold: number
  ownGiven: number
  /** Of other records, those where staff say somebody speaks and nobody does, and forms where the box is ticked by mistake. Of what is told, told a day or three late. */
  staffToldWrongly: number
  formToldWrongly: number
  toldLate: number
  /** People who file a form again from the same browser with another email or number. */
  formAgain: number
  /** Of calls again, those tapped on a browser the caller has not used, and those from another line of theirs. */
  otherBrowser: number
  otherLine: number
  /** How long before its call a tap is: up to 30 seconds, up to 60, and the rest up to three minutes. */
  quick: number
  middle: number
  /** Calls reported 5 to 120 seconds late, and out of order. */
  late: number
  /** Cold callers who dial a number somebody else was shown before. */
  oldNumber: number
  /** Records with a placeholder number, and those with an office's one email. Zero but in the dirty setting. */
  placeholder: number
  office: number
}

/** One thing reported, at a time, and the subjects it is about. */
export type Event =
  | { kind: 'visit'; at: number; device: string; address: string; ad?: string; agent: string }
  | { kind: 'tap'; at: number; device: string; address: string; agent: string }
  /** `page` is the browser whose page the number was read from, and `redial` the call whose number is dialed again. With neither, it is the number in the phone book. */
  | { kind: 'call'; at: number; id: string; from?: string; seconds: number; answered: boolean; people: readonly string[]; page?: { device: string; address: string; agent: string }; redial?: string; told?: number }
  /** Staff say somebody speaks for the subject, who gave these. */
  | { kind: 'speaks'; at: number; subject: string; speaker: { device?: string; email?: string; phone?: string } }
  /** Staff say who a call is about. */
  | { kind: 'join'; at: number; call: string; subject: string }
  /** What was given, whoever gave it. `speaker` is what of it is somebody else's, where that is told, and `own` what is the subject's besides. A firm that does not ask sends what was given as the subject's. */
  | { kind: 'record'; at: number; subject: string; device?: string; email?: string; phone?: string; name: { first: string; last: string }; dob?: string; speaker?: { device?: string; email?: string; phone?: string }; own?: { email: string; phone: string } }

export interface World {
  events: Event[]
  /** Everyone's subjects but callers, whose subject only the server can name. */
  truths: Truth[]
  /** By call id: who called, and what was told. */
  calls: Map<string, { people: string[]; facts: string[] }>
  /** Who spoke for whom, as `speaker person`. */
  spoke: Set<string>
  /** By record: the ad its person came by, or undefined where they never visited, and when the record was made. */
  ads: Map<string, { ad: string | undefined; at: number }>
}

const DAY = 86_400_000
const MINUTE = 60_000
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'
const AGENT = { telephone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile Safari', computer: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome' }

export interface Size {
  people: number
  days: number
  start: number
  seed: number
}

interface Person {
  id: string
  household: number
  mobile: string
  /** The number after it changed, and when. */
  later?: { number: string; at: number }
  emails: string[]
  telephone: Browser
  computer?: Browser
  partners: string[]
  name: { first: string; last: string; second?: string; short?: string; now?: string; listed?: { shorts: readonly string[]; english: readonly string[]; middle?: string } }
  dob: string
  /** What brought them, once it has. */
  ad?: string
}

interface Browser {
  device: string
  seen: number
  forgets: boolean
  agent: string
}

/** Numbers that look random and are the same for the same seed. */
function randomly(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x9e3779b9) >>> 0
    let z = state
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296
  }
  const chance = (share: number) => next() < share
  const under = (count: number) => Math.floor(next() * count)
  const one = <T>(list: readonly T[]): T => list[under(list.length)]!
  /** How many more times something happens, when it goes on happening with the same chance. */
  const more = (mean: number) => {
    let count = 0
    while (next() < mean / (1 + mean)) count += 1
    return count
  }
  const weighted = (shares: readonly number[]) => {
    let left = next() * shares.reduce((sum, share) => sum + share, 0)
    for (const [i, share] of shares.entries()) if ((left -= share) < 0) return i
    return shares.length - 1
  }
  return { next, chance, under, one, more, weighted }
}

/** One character changed for another, or two beside each other swapped, as a hand does. Never the same as before. */
function mistyped(text: string, r: ReturnType<typeof randomly>, letters: string): string {
  const at = r.under(text.length)
  const swapped = text.slice(0, at) + (text[at + 1] ?? '') + text[at]! + text.slice(at + 2)
  if (r.chance(0.5) && swapped !== text && swapped.length === text.length) return swapped
  let letter = r.one([...letters])
  while (letter === text[at]) letter = r.one([...letters])
  return text.slice(0, at) + letter + text.slice(at + 1)
}

export function makeWorld(rates: Rates, { people: count, days, start, seed }: Size, names?: Names): World {
  const r = randomly(seed)
  const { third } = rates
  if (third && !names) throw new TypeError('The third world requires a list of names')
  // Area code 555 is nobody's, so no number here can ring. Ten million of them, as thinly held as real ones are by a firm's people.
  const taken = new Set<string>()
  const drawn = (make: () => string) => {
    let text = make()
    while (taken.has(text)) text = make()
    taken.add(text)
    return text
  }
  const numbersOf: string[] = []
  const number = () => {
    const made = drawn(() => `+1555${String(2_000_000 + r.under(8_000_000))}`)
    numbersOf.push(made)
    return made
  }
  const letters = (count: number) => Array.from({ length: count }, () => r.one([...ALPHABET])).join('')
  const emailsOf: string[] = []
  const email = () => {
    const made = drawn(() => `${letters(6)}.${letters(4)}@example.org`)
    emailsOf.push(made)
    return made
  }
  // A few names are many people's and most are few people's, as names are: how common one is goes by its place on the list.
  // First names begin with a few letters far more often than with the rest, so two people of one home often share theirs.
  const INITIALS = { a: 10, j: 14, m: 11, c: 8, s: 7, d: 7, r: 6, l: 6, k: 6, t: 5, e: 5, b: 4, g: 3, p: 3, n: 3, h: 2, w: 2, v: 2, f: 1, i: 1, o: 1, z: 1 }
  const initial = () => Object.keys(INITIALS)[r.weighted(Object.values(INITIALS))]!
  const firsts = Array.from({ length: 300 }, () => initial() + letters(4))
  const lasts = Array.from({ length: 3_000 }, () => letters(7))
  const common = (list: readonly string[]) => list[Math.floor(list.length ** r.next()) - 1]!
  const listed = third && names ? (() => {
    const pick = <T extends { share: number }>(list: readonly T[]) => list[r.weighted(list.map((each) => each.share))]!
    return (): { first: string; shorts: readonly string[]; english: readonly string[]; middle?: string } => {
      if (!r.chance(names.spanishShare)) {
        const { name, shorts } = pick(names.english)
        return { first: name, shorts, english: [] }
      }
      const { name, shorts, english } = pick(names.spanish)
      return { first: name, shorts, english, ...(r.chance(third.compound) && { middle: pick(names.spanish).name }) }
    }
  })() : undefined
  const named = (last: string): Person['name'] => {
    if (listed) {
      const { first, shorts, english, middle } = listed()
      return {
        first, last, listed: { shorts, english, ...(middle !== undefined && { middle }) },
        ...(r.chance(rates.twoSurnames) && { second: common(lasts) }),
        ...(r.chance(rates.surnameChanged) && { now: common(lasts) }),
      }
    }
    const first = common(firsts)
    return {
      first, last,
      ...(r.chance(rates.twoSurnames) && { second: common(lasts) }),
      ...(r.chance(rates.hasShort) && { short: (r.chance(rates.shortOtherInitial) ? initial() : first[0]!) + letters(3) }),
      ...(r.chance(rates.surnameChanged) && { now: common(lasts) }),
    }
  }
  const dayOf = (year: number) => `${year}-${String(1 + r.under(12)).padStart(2, '0')}-${String(1 + r.under(28)).padStart(2, '0')}`
  let devices = 0
  const device = () => `d${seed}-${devices++}`
  const browser = (agent: string, forgets: boolean): Browser => ({ device: device(), seen: -Infinity, forgets, agent })

  const people: Person[] = []
  const spoke: World['spoke'] = new Set()
  const ads: World['ads'] = new Map()
  const landlines: (string | undefined)[] = []
  for (let household = 0; people.length < count; household++) {
    const adults = Math.min(r.weighted(rates.adults) + 1, count - people.length)
    landlines.push(r.chance(rates.landline) ? number() : undefined)
    const shared = adults > 1 && r.chance(rates.sharedComputer) ? browser(AGENT.computer, false) : undefined
    const both = adults > 1 && r.chance(rates.sharedEmail) ? email() : undefined
    const last = common(lasts)
    const own: Person[] = []
    for (let i = 0; i < adults; i++) {
      const id = `p${people.length + own.length}`
      const emails = [both !== undefined && i < 2 ? both : email()]
      if (r.chance(rates.secondEmail)) emails.push(email())
      own.push({
        id, household, mobile: number(), emails, partners: [], name: named(r.chance(0.8) ? last : common(lasts)), dob: dayOf(1940 + r.under(65)),
        telephone: browser(AGENT.telephone, r.chance(rates.forgets)),
        ...(shared ? { computer: shared } : r.chance(rates.hasComputer) && { computer: browser(AGENT.computer, false) }),
      })
    }
    if (own.length > 1 && r.chance(rates.twins)) own[1]!.dob = own[0]!.dob
    if (own.length > 1 && r.chance(rates.namesakes)) own[1]!.name = { ...own[0]!.name }
    if (third && own.length > 1 && r.chance(third.alike)) own[1]!.name = { ...own[1]!.name, first: mistyped(own[0]!.name.first, r, ALPHABET) }
    for (const person of own) person.partners = own.filter((other) => other !== person).map((other) => other.id)
    people.push(...own)
  }
  const byId = new Map(people.map((person) => [person.id, person]))
  // A number that changes goes back to the carrier. Whoever is given it next is a person of this world too, and has it from then on.
  for (const person of people) {
    if (!r.chance(rates.numberChanges * (days / 365))) continue
    const at = start + r.under(days) * DAY
    person.later = { number: number(), at }
    const next = r.one(people)
    // A number rests before it is given again: 45 days, the least a carrier here may let it.
    if (next !== person && !next.later && r.chance(rates.reusedHere)) next.later = { number: person.mobile, at: at + 45 * DAY }
  }

  const events: Event[] = []
  const factsOf = new Map<string, { people: Set<string>; facts: Set<string> }>()
  const note = (subject: string, person: string, ...facts: (string | undefined)[]) => {
    const known = factsOf.get(subject) ?? { people: new Set<string>(), facts: new Set<string>() }
    factsOf.set(subject, known)
    known.people.add(person)
    for (const fact of facts) if (fact !== undefined) known.facts.add(fact)
  }
  const calls: World['calls'] = new Map()
  const otherLines = new Map<string, string>()
  const shownCalls: string[] = []
  const phoneOf = (person: Person, at: number) => (person.later && at >= person.later.at ? person.later.number : person.mobile)
  const home = (person: Person) => `2001:db8:${(person.household + 1).toString(16)}::${(person.household % 250) + 2}`

  const visit = (person: Person, at: number, ad?: string): { device: string; address: string; agent: string } => {
    const onComputer = person.computer !== undefined && r.chance(rates.onComputer)
    const used = onComputer ? person.computer! : person.telephone
    const gap = at - used.seen
    const lost = used.seen > 0 && ((used.forgets && gap > 7 * DAY) || r.chance(1 - (1 - rates.clearedMonthly) ** (gap / (30 * DAY))))
    if (lost) used.device = device()
    used.seen = at
    const address = !onComputer && r.chance(rates.carrier) ? `198.51.100.${r.under(40) + 1}` : home(person)
    note(`visitor:${used.device}`, person.id, `device ${used.device}`)
    events.push({ kind: 'visit', at, device: used.device, address, agent: used.agent, ...(ad !== undefined && { ad }) })
    if (used.agent === AGENT.telephone && r.chance(rates.idleTap)) events.push({ kind: 'tap', at: at + 20_000 + r.under(3 * MINUTE), device: used.device, address, agent: used.agent })
    return { device: used.device, address, agent: used.agent }
  }

  let records = 0
  /** Records as they are made, for staff to join a call to one there is by then. */
  const made: { subject: string; person: string; at: number }[] = []
  const record = (person: Person, at: number, told: { device?: string; email?: string; phone?: string }, staff: boolean, speaker: Person = person) => {
    const subject = `contact:${records++}`
    const facts = { ...told }
    let speaks: { device?: string; email?: string; phone?: string } | undefined
    let own: { email: string; phone: string } | undefined
    let late = false
    const name = third && speaker !== person && r.chance(third.speakersName) ? speaker.name : person.name
    if (third) {
      const spokenFor = speaker !== person
      if (r.chance(spokenFor ? (staff ? third.staffTold : third.formTold) : staff ? third.staffToldWrongly : third.formToldWrongly)) {
        // A desk knows the line that rang. A form knows all that its sender gave.
        speaks = staff ? { ...(facts.phone !== undefined && { phone: facts.phone }) } : { ...facts }
        late = r.chance(third.toldLate)
        if (!staff && spokenFor && !late && r.chance(third.ownGiven)) own = { phone: phoneOf(person, at), email: r.one(person.emails) }
      }
      if (r.chance(third.placeholder)) facts.phone = r.one(['+15555555555', '+11234567890', '+10000000000', '+15551234567'])
      if (r.chance(third.office)) facts.email = r.one(['info@office-a.example.org', 'office@office-b.example.org', 'admin@office-c.example.org'])
      if (speaks && Object.keys(speaks).length === 0) speaks = undefined
      if (speaks && late) events.push({ kind: 'speaks', at: at + Math.ceil((1 + r.next() * 2) * DAY), subject, speaker: speaks })
    }
    note(subject, person.id, facts.device && `device ${facts.device}`, facts.email && `email ${facts.email}`, facts.phone && `phone ${facts.phone}`, own && `email ${own.email}`, own && `phone ${own.phone}`)
    ads.set(subject, { ad: person.ad, at })
    events.push({ kind: 'record', at, subject, ...facts, ...(speaks && !late && { speaker: speaks }), ...(own && { own }), name: typedName(name, staff), ...(r.chance(rates.birthAsked) && { dob: typedBirth(person.dob, staff) }) })
    made.push({ subject, person: person.id, at })
    return subject
  }
  // A digit of the area code mistyped could be anybody's, so the seven after it stand for all ten. Any of them can be wrong.
  const typedPhone = (phone: string, share: number) => (!r.chance(share) ? phone : r.chance(rates.typoMeets) ? r.one(numbersOf) : '+1555' + mistyped(phone.slice(5), r, '0123456789'))
  const typedEmail = (address: string, share: number) => {
    const [name, host] = address.split('@') as [string, string]
    return !r.chance(share) ? address : r.chance(rates.typoMeets) ? r.one(emailsOf) : `${mistyped(name, r, ALPHABET)}@${host}`
  }
  const typedName = (name: Person['name'], staff: boolean) => {
    let first = name.short !== undefined && r.chance(rates.shortGiven) ? name.short : name.first
    if (third && name.listed) {
      const { shorts, english, middle } = name.listed
      if (shorts.length > 0 && r.chance(third.shortGiven)) first = r.one(shorts)
      else if (english.length > 0 && r.chance(third.englishGiven)) first = r.one(english)
      else if (middle !== undefined) first = r.chance(third.compoundHalved) ? r.one([first, middle]) : `${first} ${middle}`
    }
    const surname = name.now !== undefined && r.chance(0.5) ? name.now : name.last
    const last = name.second === undefined ? surname : r.chance(rates.oneLeftOut) ? r.one([surname, name.second]) : `${surname} ${name.second}`
    if (r.chance(rates.transliterated)) first = (r.chance(0.3) ? initial() : first[0]!) + letters(first.length - 1)
    if (third && r.chance(third.swapped)) return { first: last, last: first }
    if (!r.chance(staff ? rates.staffNameTypo : rates.nameTypo)) return { first, last }
    return r.chance(0.5) ? { first: mistyped(first, r, ALPHABET), last } : { first, last: mistyped(last, r, ALPHABET) }
  }
  const typedBirth = (dob: string, staff: boolean) => (!r.chance(staff ? rates.staffBirthTypo : rates.birthTypo) ? dob : dayOf(Number(dob.slice(0, 4))))
  /** A moment of a day, most often in the ten hours a firm is open. */
  const moment = (day: number) => start + day * DAY + Math.floor(r.next() * (r.chance(0.8) ? 10 * 60 * MINUTE : DAY))

  // Every visit has its time before any is made, so a browser two people use is used in the order they used it.
  const todo: { at: number; run: () => void }[] = []
  const acting = new Set<string>()
  for (const person of people) {
    const firstDay = r.under(Math.ceil(days * 0.6))
    const acts = !r.chance(rates.onlyVisit) || (person.partners.some((partner) => acting.has(partner)) && r.chance(rates.together))
    if (acts) acting.add(person.id)
    const calling = acts && r.chance(rates.call)
    const filling = acts && (r.chance(rates.form) || !calling)
    const visits = r.more(rates.visits)
    const actsOn = r.under(visits + 1)
    // Another adult of the household may speak for them: theirs are the hands, most often on their own telephone or computer.
    const speaker = person.partners.length > 0 && r.chance(rates.spokenFor) ? byId.get(r.one(person.partners))! : person
    if (acts && speaker !== person) spoke.add(`${speaker.id} ${person.id}`)
    const theirs = speaker !== person && r.chance(rates.speakerVisits)
    let last = start
    let day = firstDay
    for (let i = 0; i <= visits; i++) {
      if (i > 0) day += r.under(13)
      if (day >= days) break
      const when = Math.max(last + MINUTE, moment(day))
      last = when
      todo.push({ at: when, run: () => {
        const doing = acts && i === actsOn
        const visitor = doing && theirs ? speaker : person
        person.ad ??= `ad-${person.id}`
        const here = visit(visitor, when, i === 0 ? person.ad : undefined)
        if (!doing) return
        if (filling) form(person, speaker, when, here.device)
        if (calling) call(person, speaker, visitor, when, here, filling)
      } })
    }
    // Somebody entered again, later, by someone who did not look.
    if (acts && r.chance(rates.duplicate)) {
      const later = last + Math.ceil((5 + r.next() * 30) * DAY)
      todo.push({ at: later, run: () => void record(person, later, { phone: typedPhone(phoneOf(person, later), rates.staffPhoneTypo), ...(r.chance(rates.emailAsked) && { email: typedEmail(r.one(person.emails), rates.staffEmailTypo) }) }, true) })
    }
  }
  // People who only call. They are nobody's household here.
  const cold = Math.round(people.length * rates.cold)
  for (let i = 0; i < cold; i++) {
    const own = number()
    const stranger: Person = { id: `q${i}`, household: -1, mobile: own, emails: [email()], partners: [], telephone: browser(AGENT.telephone, false), name: named(common(lasts)), dob: dayOf(1940 + r.under(65)) }
    const at = moment(r.under(days))
    todo.push({ at, run: () => ring(stranger, stranger, at, undefined, undefined, r.chance(rates.coldRecorded), third && r.chance(third.oldNumber)) })
  }

  function form(person: Person, speaker: Person, at: number, from: string) {
    const soon = at + Math.ceil(r.next() * 15 * MINUTE) + MINUTE
    record(person, soon, { device: from, email: typedEmail(r.one(speaker.emails), rates.ownEmailTypo), phone: typedPhone(phoneOf(speaker, soon), rates.ownPhoneTypo) }, false, speaker)
    if (!third || !r.chance(third.formAgain)) return
    // Filed again from the same browser, with an email or a number not given before.
    const again = soon + Math.ceil((0.05 + r.next() * 3) * DAY)
    record(person, again, r.chance(0.5) ? { device: from, email: email(), phone: phoneOf(speaker, again) } : { device: from, email: r.one(speaker.emails), phone: number() }, false, speaker)
  }

  /** A call from a visit. Whoever is on the page can tap the number, and nobody else can. */
  function call(person: Person, speaker: Person, visitor: Person, at: number, here: ReturnType<typeof visit>, filled: boolean) {
    const when = at + Math.ceil(r.next() * 10 * MINUTE) + (third ? 190_000 : 30_000)
    const tapped = visitor === speaker && r.chance(here.agent === AGENT.telephone ? rates.tapsTelephone : rates.tapsComputer)
    ring(person, speaker, when, here, tapped ? here : undefined, !filled || r.chance(rates.duplicate))
  }

  /** A call, and what staff make of it. Those who call again do it later, with nothing to tap. */
  function ring(person: Person, speaker: Person, at: number, page: ReturnType<typeof visit> | undefined, tapped: ReturnType<typeof visit> | undefined, recorded: boolean, old = false) {
    const times = 1 + r.more(rates.again)
    let when = at
    const own: string[] = []
    for (let i = 0; i < times; i++) {
      if (i > 0) when += Math.ceil((0.01 + r.next() * 8) * DAY)
      const landline = landlines[speaker.household]
      const hidden = r.chance(rates.hidden)
      const line = third && i > 0 && r.chance(third.otherLine) ? (otherLines.get(speaker.id) ?? otherLines.set(speaker.id, number()).get(speaker.id)!) : undefined
      const from = line ?? (landline !== undefined && r.chance(rates.landlineUse) ? landline : phoneOf(speaker, when))
      const id = `c${seed}-${calls.size}`
      let tap = i === 0 ? tapped : undefined
      let shownOn = i === 0 ? page : undefined
      if (third && i > 0 && page && r.chance(third.otherBrowser)) {
        // On a browser of theirs not seen here before, and so on its page.
        const fresh = browser(AGENT.telephone, false)
        note(`visitor:${fresh.device}`, speaker.id, `device ${fresh.device}`)
        const address = speaker.household >= 0 ? home(speaker) : '198.51.100.9'
        events.push({ kind: 'visit', at: when - 4 * MINUTE, device: fresh.device, address, agent: fresh.agent })
        tap = shownOn = { device: fresh.device, address, agent: fresh.agent }
      }
      if (tap) {
        const x = third ? r.next() : 0
        const gap = !third ? 8_000 + r.under(20_000) : x < third.quick ? 5_000 + r.under(25_000) : x < third.quick + third.middle ? 30_000 + r.under(30_000) : 60_000 + r.under(120_000)
        events.push({ kind: 'tap', at: when - gap, device: tap.device, address: tap.address, agent: tap.agent })
        note(`visitor:${tap.device}`, speaker.id, `tap ${id}`)
      }
      const answered = r.chance(rates.answered)
      const redial = i > 0 && !shownOn && r.chance(rates.redialed) ? own[0] : undefined
      own.push(id)
      // Written down by somebody, and passed on.
      const passed = old && i === 0 && shownCalls.length > 0 ? r.one(shownCalls) : undefined
      if (shownOn) shownCalls.push(id)
      const dialedAgain = passed ?? redial
      // Of a landline or a number passed on, it is whoever made this call.
      calls.set(id, { people: [speaker.id], facts: [...(hidden ? [] : [`phone ${from}`]), ...(tap ? [`tap ${id}`] : [])] })
      events.push({ kind: 'call', at: when, id, ...(!hidden && { from }), seconds: answered ? 60 + r.under(600) : 12 + r.under(25), answered, people: [speaker.id], ...(shownOn && { page: shownOn }), ...(dialedAgain !== undefined && { redial: dialedAgain }), ...(third && r.chance(third.late) && { told: when + 5_000 + r.under(115_000) }) })
      // Staff make a record from what they hear and see: the number calling, unless it is hidden, and an email where one is asked for.
      if (!answered) continue
      if (recorded) {
        recorded = false
        const given = hidden ? phoneOf(speaker, when) : from
        record(person, when + 5 * MINUTE, { phone: typedPhone(given, hidden ? rates.staffPhoneTypo : 0), ...(r.chance(rates.emailAsked) && { email: typedEmail(r.one(speaker.emails), rates.staffEmailTypo) }) }, true, speaker)
      }
      // Whoever answers opens the record the call is about, where there is one, and now and then somebody else's.
      const there = made.filter((each) => each.at <= when + 6 * MINUTE)
      const theirs = there.filter((each) => each.person === person.id)
      if (theirs.length > 0 && r.chance(rates.staffJoins)) events.push({ kind: 'join', at: when + 6 * MINUTE, call: id, subject: (r.chance(rates.staffJoinsWrong) ? r.one(there) : theirs.at(-1)!).subject })
    }
  }

  for (const { run } of todo.sort((x, y) => x.at - y.at)) run()
  const truths = [...factsOf].map(([subject, known]): Truth => ({ subject, people: [...known.people], facts: [...known.facts] }))
  // What was put off to its own time is reported then.
  const reported = (event: Event) => (event.kind === 'call' && event.told) || event.at
  return { events: events.sort((x, y) => reported(x) - reported(y)), truths, calls, spoke, ads }
}
