/** A domain "no" is a value, never an exception. */
export type Outcome<T, E = string> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: E }

/** An Outcome whose "no" carries what that reason needs. */
export type Decided<T, R extends { readonly reason: string }> = { readonly ok: true; readonly value: T } | ({ readonly ok: false } & R)

export const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value })
export const no = <R extends { readonly reason: string }>(refusal: R): { readonly ok: false } & R => ({ ok: false, ...refusal })
