// What a record is called: its name, phone and email as they were given, for people to read.
import type { Subject } from '../contract/types.ts'

/** The plain values kept of a record. Matching never reads them: it works from the hashes. */
export type DetailField = 'name' | 'phone' | 'email' | 'dob' | 'address' | 'line' | 'callerName' | 'callerPlace'
/** The kinds of phone line a lookup can find that staff act on: whether a number can be texted, and whether it is an app's. */
export const LINES = new Set(['mobile', 'landline', 'fixedVoip', 'nonFixedVoip'])
export type Details = Partial<Record<DetailField, string>>
/** One of them as kept: the value, and the entry that said it. The newest by (`at`, `key`) stands. */
export type DetailSaid = { value: string; at: number; key: string }

/** What a person is called: the values kept of their group, and for a record the graph made, the record of your own system that stands for them. */
export type Called = Details & { record?: Subject; phones?: string[]; emails?: string[] }

/** A phone number as a person writes it, where it is a North American one, and as given otherwise. */
export function shownPhone(phone: string): string {
  const national = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone)
  return national ? `(${national[1]}) ${national[2]}-${national[3]}` : phone
}

/** Whether the graph made this record, of a browser, a phone or a call. The others are yours. */
export const madeByGraph = (subject: Subject) => /^(visitor|caller|call):/.test(subject)
const made = madeByGraph

/**
 * What to call a person, from what is kept of the records in their group: a name where any record has one,
 * a phone where any has one, and the record of your own system that stands for them.
 * `subject` is the record asked about, and comes first where it has a value of its own.
 */
export function called(subject: Subject, members: readonly Subject[], kept: ReadonlyMap<Subject, Details>): Called {
  const order = [subject, ...members.filter((each) => each !== subject && !made(each)), ...members.filter((each) => each !== subject && made(each))]
  const first = (field: DetailField) => order.map((each) => kept.get(each)?.[field]).find((value) => value !== undefined)
  const [name, phone, email] = [first('name'), first('phone'), first('email')]
  // A date of birth and an address are for the account page alone, and `born` adds them there.
  const record = made(subject) ? order.find((each) => !made(each)) : undefined
  return { ...(name !== undefined && { name }), ...(phone !== undefined && { phone }), ...(email !== undefined && { email }), ...(record !== undefined && { record }) }
}

/**
 * What is kept of a person beyond what they are called: their date of birth, address and kind of phone line, and what the phone company says of a number's caller.
 * Each is from the first record of their group that has it. It is for the account page and the open call, and nowhere else.
 */
const BEYOND = ['dob', 'address', 'line', 'callerName', 'callerPlace'] as const
export function born(subject: Subject, members: readonly Subject[], kept: ReadonlyMap<Subject, Details>): Pick<Details, typeof BEYOND[number]> {
  // What the phone company says is of a number, so it is read from the records the graph made of numbers too.
  const order = [subject, ...members.filter((each) => each !== subject)]
  const found: Pick<Details, typeof BEYOND[number]> = {}
  for (const field of BEYOND) {
    const value = order.filter((each) => each === subject || field.startsWith('caller') || !madeByGraph(each)).map((each) => kept.get(each)?.[field]).find((value) => value !== undefined)
    if (value !== undefined) found[field] = value
  }
  return found
}
