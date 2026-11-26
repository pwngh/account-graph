/**
 * Facts that are the same for everybody and change slowly, kept as tables so
 * nothing is asked of anyone. Each answers one question and decides nothing.
 */
import { malformed } from '../contract/fault.ts'
import { BlockList, isIP } from 'node:net'
import type { IpLookup } from './ports.ts'
import { ZIPS } from './texas-zips.ts'

const words = (text: string) => new Set(text.trim().split(/\s+/))
/** Without case or accents. */
const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * Why an E.164 number is nobody's, or undefined when it could be somebody's.
 * North America only: one digit over and over, a count, an area code or an
 * exchange that is never given out. 555 is for films and for directories.
 */
export function fakePhone(e164: string): 'repeated' | 'counted' | 'never_assigned' | undefined {
  const [, national, area, exchange] = /^\+1((\d{3})(\d{3})\d{4})$/.exec(e164) ?? []
  if (!national) return undefined
  if (/^(\d)\1{9}$/.test(national)) return 'repeated'
  if (['1234567890', '0123456789', '9876543210', '0987654321'].includes(national)) return 'counted'
  // Neither part begins with 0 or 1, or is like 911.
  for (const part of [area!, exchange!]) if (/^[01]|^.11$/.test(part)) return 'never_assigned'
  return exchange === '555' ? 'never_assigned' : undefined
}

/** What is written where there is no email, at any domain. Too short or too plain for anybody's own. */
const NO_EMAIL = words('none noemail no-email no.email nomail nothave donthave dont-have noone asdf asdfasdf qwerty test testing tester fake fakeemail notiene notengo sincorreo sinemail ninguno')
const NO_DOMAIN = words('none.com no.com na.com noemail.com nomail.com noemail.net test.com testing.com asdf.com fake.com null.com example.com example.net')

/** Whether an email was made up to fill a field in. */
export function placeholderEmail(email: string): boolean {
  const [name, domain] = split(email)
  if (!domain) return false
  return NO_DOMAIN.has(domain) || /\.(invalid|test|localhost)$/.test(`.${domain}`) || NO_EMAIL.has(name)
}

/** Mail anybody can open an address at. A name such as `office` is a person's there. */
const PUBLIC = words('gmail.com googlemail.com yahoo.com yahoo.es yahoo.com.mx ymail.com rocketmail.com hotmail.com hotmail.es outlook.com outlook.es live.com msn.com aol.com icloud.com me.com mac.com mail.com gmx.com proton.me protonmail.com att.net sbcglobal.net bellsouth.net swbell.net comcast.net verizon.net cox.net charter.net earthlink.net suddenlink.net prodigy.net.mx')
const ROLES = words('info office contact admin administrator sales support help frontdesk front.desk reception receptionist billing accounting accounts hello team mail noreply no-reply donotreply do-not-reply webmaster postmaster hr jobs careers legal intake recepcion contacto oficina ventas ayuda facturacion')

/** Whether an email is an office's, which several people read. */
export function sharedMailbox(email: string): boolean {
  const [name, domain] = split(email)
  return Boolean(domain) && !PUBLIC.has(domain) && ROLES.has(name)
}

const THROWAWAY = words('10minutemail.com 20minutemail.com burnermail.io dispostable.com emailondeck.com fakeinbox.com getairmail.com getnada.com grr.la guerrillamail.com guerrillamail.net guerrillamail.org guerrillamailblock.com mailcatch.com maildrop.cc mailinator.com mailnesia.com mintemail.com mohmal.com mytemp.email sharklasers.com spamgourmet.com temp-mail.org tempail.com tempmail.com tempmailo.com throwawaymail.com trashmail.com yopmail.com')

/** Whether an email is at one of the best known services that give an address for a few minutes. Most are not in the table. */
export const throwawayEmail = (email: string): boolean => THROWAWAY.has(split(email)[1])

const MEANT: Record<string, string> = {
  'gmail.com': 'gmial.com gmal.com gmai.com gmil.com gamil.com gnail.com gmaill.com gmaiil.com ggmail.com gmail.con gmail.comm gmail.cmo gmail.ccom gmailcom',
  'yahoo.com': 'yaho.com yahooo.com yhaoo.com yaoo.com yahho.com yahoo.con yahoo.comm yahoo.cmo',
  'hotmail.com': 'hotmial.com hotmal.com hotmai.com hotmil.com hotnail.com homail.com hotmail.con hotmail.comm hotmail.cmo',
  'outlook.com': 'outlok.com outloook.com oulook.com outllook.com outlook.con outlook.comm',
  'icloud.com': 'iclod.com icoud.com iclould.com icluod.com icloud.con icloud.comm',
  'aol.com': 'aol.con aol.comm aoll.com',
}
const TYPOS = new Map(Object.entries(MEANT).flatMap(([meant, typed]) => [...words(typed)].map((each) => [each, meant] as const)))

/** The address somebody most likely meant, where the domain is a well known one misspelled. It is a suggestion, and the address may be right as it is. */
export function meantEmail(email: string): string | undefined {
  const clean = email.trim()
  const at = clean.lastIndexOf('@')
  const meant = at > 0 ? TYPOS.get(clean.slice(at + 1).toLowerCase()) : undefined
  return meant && `${clean.slice(0, at)}@${meant}`
}

function split(email: string): [name: string, domain: string] {
  const clean = email.trim().toLowerCase()
  const at = clean.lastIndexOf('@')
  return at > 0 ? [clean.slice(0, at), clean.slice(at + 1)] : [clean, '']
}

const TEXAS: Record<string, string> = {
  Houston: '713 281 832 346 621', Dallas: '214 469 972 945', 'Fort Worth': '817 682', Austin: '512 737', 'San Antonio': '210 726', 'El Paso': '915',
  'Beaumont and Galveston': '409', 'Conroe and Huntsville': '936', 'College Station': '979', 'Corpus Christi': '361', 'Laredo and the Rio Grande Valley': '956',
  'Tyler and Longview': '903 430', 'Waco and Killeen': '254', Abilene: '325', 'Midland and Odessa': '432', 'Lubbock and Amarillo': '806', 'New Braunfels and the Hill Country': '830', 'Denton and Wichita Falls': '940',
}
const AREAS = new Map(Object.entries(TEXAS).flatMap(([place, codes]) => [...words(codes)].map((code) => [code, place] as const)))

/** Where in Texas a number was first given out, or undefined. People keep a number when they move, so it says where they may be from. */
export const texasArea = (e164: string): string | undefined => AREAS.get(/^\+1(\d{3})\d{7}$/.exec(e164)?.[1] ?? '')

const COUNTIES = new Map(Object.entries(ZIPS).flatMap(([county, zips]) => zips.split(' ').map((zip) => [zip, county] as const)))

/** The Texas county a ZIP code lies in, or undefined where it lies in several, or in none. By land and the 2020 census, so a new ZIP is not in it. */
export const texasCounty = (zip: string): string | undefined => COUNTIES.get(/^(\d{5})(-\d{4})?$/.exec(zip.trim())?.[1] ?? '')

const iso = (date: Date) => date.toISOString().slice(0, 10)
const day = (year: number, month: number, date: number) => new Date(Date.UTC(year, month - 1, date))
/** The nth of a weekday in a month, and the last for -1. Sunday is 0. */
const nth = (year: number, month: number, weekday: number, n: number) => {
  if (n < 0) {
    const last = day(year, month + 1, 0)
    return day(year, month, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7))
  }
  return day(year, month, 1 + ((weekday - day(year, month, 1).getUTCDay() + 7) % 7) + (n - 1) * 7)
}
/** A holiday on a Saturday is kept on Friday, and one on a Sunday on Monday. */
const kept = (date: Date) => new Date(date.getTime() + (date.getUTCDay() === 6 ? -1 : date.getUTCDay() === 0 ? 1 : 0) * 86_400_000)

/** The first year with every one of them but Juneteenth, which is a holiday since 2021. */
export const HOLIDAYS_SINCE = 1986

/**
 * The federal holidays of a year as days `YYYY-MM-DD`, on the day they are
 * kept, for `OPEN_HOURS`. With `texas`, the days after Thanksgiving and around
 * Christmas that the state closes too, where they fall on a weekday.
 */
export function holidays(year: number, { texas = false }: { texas?: boolean } = {}): string[] {
  if (!Number.isSafeInteger(year) || year < HOLIDAYS_SINCE || year > 9999) throw malformed(`A year is a whole number from ${HOLIDAYS_SINCE}`)
  const thanksgiving = nth(year, 11, 4, 4)
  const days = [
    kept(day(year, 1, 1)), nth(year, 1, 1, 3), nth(year, 2, 1, 3), nth(year, 5, 1, -1), ...(year >= 2021 ? [kept(day(year, 6, 19))] : []), kept(day(year, 7, 4)),
    nth(year, 9, 1, 1), nth(year, 10, 1, 2), kept(day(year, 11, 11)), thanksgiving, kept(day(year, 12, 25)),
    // New Year's Day of the next year can be kept on the last of this one.
    kept(day(year + 1, 1, 1)),
  ]
  if (texas) days.push(new Date(thanksgiving.getTime() + 86_400_000), ...[day(year, 12, 24), day(year, 12, 26)].filter((each) => each.getUTCDay() % 6 !== 0))
  return [...new Set(days.map(iso).filter((each) => each.startsWith(`${year}-`)))].sort()
}

const ALTO = words('alto pare parar detener cancelar baja salir terminar fin')

/** Whether a text is one Spanish word that asks for no more. Inside a sentence the same word says nothing. No Spanish word undoes it. START does. */
export const spanishStop = (text: string): boolean => ALTO.has(fold(text.trim().replace(/^[¡]+|[.!]+$/g, '')))

const NADIE = new Set(['desconocido', 'desconocida', 'sin nombre', 'no tiene', 'no dio', 'ninguno', 'ninguna', 'nadie', 'cliente', 'prueba', 'nombre', 'apellido', 'no sabe'])

/** Whether a name is what is written in Spanish where none is known. */
export const spanishPlaceholder = (name: string): boolean => NADIE.has(fold(name).replace(/[^a-z]+/g, ' ').trim())

/**
 * A lookup that knows data centers by the ranges their owners publish, from
 * any text that holds them, such as the JSON of a cloud provider. It asks
 * nobody. A range that is not one is left out, as is one of every address, and no range at all is refused.
 */
export function createRangeLookup(text: string): IpLookup {
  const list = new BlockList()
  let count = 0
  for (const [, address, bits] of text.matchAll(/(?<![\w.:])([\da-f]*[.:][\da-f.:]+)\/(\d{1,3})(?![\w.])/gi)) {
    const version = isIP(address!)
    if (version === 0 || Number(bits) === 0 || Number(bits) > (version === 4 ? 32 : 128)) continue
    list.addSubnet(address!, Number(bits), version === 4 ? 'ipv4' : 'ipv6')
    count += 1
  }
  if (count === 0) throw malformed('No address range, such as 192.0.2.0/24, was found')
  return async (address) => {
    const version = isIP(address)
    if (version === 0 || !list.check(address, version === 4 ? 'ipv4' : 'ipv6')) return undefined
    return { country: undefined, asn: undefined, organization: undefined, userType: undefined, anonymous: false, hosting: true }
  }
}
