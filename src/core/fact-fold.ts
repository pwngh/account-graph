import type { Identifier } from '../contract/types.ts'
import { later } from './said.ts'

export interface FactStamp { at: number; key: string }
export interface FactProfile extends FactStamp { fact?: Identifier }
export type Withdrawals = ReadonlyMap<Identifier, FactStamp>

export const contactFact = (id: Identifier) => id.replace(/^voip:/, 'phone:')

/** Old named hashes cannot tell us which contact they used. A new keyed profile can establish their source. */
export function factActive(id: Identifier, profile: FactProfile | undefined, withdrawn: Withdrawals): boolean {
  let last = withdrawn.get(contactFact(id))
  if (profile?.fact) {
    const source = withdrawn.get(contactFact(profile.fact))
    if (source && (!last || later(source, last) > 0)) last = source
  } else if (id.startsWith('named:')) {
    for (const source of withdrawn.keys()) if (/^(email|phone):/.test(source)) return false
  }
  return !last || !!profile && later(profile, last) > 0
}
