/**
 * The rates each setting is made with. They were set from the sources in
 * `docs/accuracy.md` before anything was run, and are not to be changed to
 * suit a result. The run at 17b7a53 had those here then; what is new since is
 * for the second run.
 */
import type { Rates } from './world.ts'

interface Setting {
  rates: Rates
  people: number
  days: number
  /** Numbers in the pool, for the arm that has one. */
  pool: number
}

const base: Rates = {
  adults: [35, 47, 12, 6],
  landline: 0.196,
  landlineUse: 0.18,
  sharedComputer: 0.35,
  sharedEmail: 0.15,
  hasComputer: 0.7,
  onComputer: 0.35,
  forgets: 0.5,
  clearedMonthly: 0.15,
  carrier: 0.35,
  secondEmail: 0.1,
  numberChanges: 0.06,
  reusedHere: 0.0005,
  typoMeets: 0.0001,
  nameTypo: 0.03,
  staffNameTypo: 0.08,
  birthTypo: 0.01,
  staffBirthTypo: 0.02,
  twins: 0.007,
  namesakes: 0.01,
  hasShort: 0.35,
  shortGiven: 0.3,
  shortOtherInitial: 0.25,
  surnameChanged: 0.03,
  twoSurnames: 0.2,
  oneLeftOut: 0.35,
  transliterated: 0.015,
  staffJoins: 0.85,
  staffJoinsWrong: 0.01,
  redialed: 0.7,
  birthAsked: 0.5,
  speakerVisits: 0.8,
  idleTap: 0.015,
  cold: 0.08,
  coldRecorded: 0.5,
  again: 0.6,
  ownEmailTypo: 0.05,
  ownPhoneTypo: 0.03,
  staffEmailTypo: 0.05,
  staffPhoneTypo: 0.01,
  hidden: 0.03,
  tapsTelephone: 0.85,
  tapsComputer: 0.03,
  spokenFor: 0.05,
  duplicate: 0.1,
  onlyVisit: 0.8,
  together: 0.1,
  form: 0.4,
  call: 0.6,
  answered: 0.8,
  emailAsked: 0.6,
  visits: 1.5,
}

export const SETTINGS: Record<string, Setting> = {
  /** The middle of every range. */
  base: { rates: base, people: 2_000, days: 120, pool: 10 },
  /** Every rate at the kind end of its range. */
  low: {
    rates: { ...base, adults: [40, 44, 11, 5], landline: 0.18, landlineUse: 0.1, sharedComputer: 0.2, sharedEmail: 0.08, onComputer: 0.3, forgets: 0.45, clearedMonthly: 0.05, carrier: 0.2, secondEmail: 0.05, numberChanges: 0.03, reusedHere: 0.0001, ownEmailTypo: 0.02, ownPhoneTypo: 0.01, staffEmailTypo: 0.02, staffPhoneTypo: 0.003, hidden: 0.01, tapsTelephone: 0.95, tapsComputer: 0.1, spokenFor: 0.02, duplicate: 0.05, together: 0.05, typoMeets: 0.00002, nameTypo: 0.01, staffNameTypo: 0.03, birthTypo: 0.005, staffBirthTypo: 0.01, twins: 0.003, namesakes: 0.005, hasShort: 0.2, shortGiven: 0.15, shortOtherInitial: 0.15, surnameChanged: 0.01, twoSurnames: 0.1, oneLeftOut: 0.2, transliterated: 0.005, staffJoins: 0.95, staffJoinsWrong: 0.002, redialed: 0.8, idleTap: 0.005, cold: 0.03, again: 0.3 },
    people: 2_000,
    days: 120,
    pool: 10,
  },
  /** Every rate at the hard end of its range, all at once. */
  high: {
    rates: { ...base, adults: [30, 50, 13, 7], landline: 0.21, landlineUse: 0.3, sharedComputer: 0.5, sharedEmail: 0.27, onComputer: 0.4, forgets: 0.55, clearedMonthly: 0.31, carrier: 0.5, secondEmail: 0.25, numberChanges: 0.12, reusedHere: 0.005, ownEmailTypo: 0.15, ownPhoneTypo: 0.1, staffEmailTypo: 0.15, staffPhoneTypo: 0.04, hidden: 0.08, tapsTelephone: 0.7, tapsComputer: 0, spokenFor: 0.1, duplicate: 0.2, together: 0.25, typoMeets: 0.001, nameTypo: 0.08, staffNameTypo: 0.15, birthTypo: 0.03, staffBirthTypo: 0.05, twins: 0.015, namesakes: 0.02, hasShort: 0.5, shortGiven: 0.45, shortOtherInitial: 0.35, surnameChanged: 0.08, twoSurnames: 0.35, oneLeftOut: 0.5, transliterated: 0.04, staffJoins: 0.6, staffJoinsWrong: 0.03, redialed: 0.6, idleTap: 0.04, cold: 0.18, again: 1 },
    people: 2_000,
    days: 120,
    pool: 10,
  },
  /** The middle rates on a busy line, where strangers tap and call at about the same time. */
  busy: { rates: base, people: 6_000, days: 5, pool: 40 },
}
