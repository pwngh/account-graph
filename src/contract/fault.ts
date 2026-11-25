/**
 * What is thrown, and what is answered. A "no" the domain gives is a value
 * (`Outcome`, `Decided`). A fault is thrown, and is told by its code, never
 * by its message.
 */
export const FAULT_CODES = Object.freeze({
  INPUT: Object.freeze({ MALFORMED: 'INPUT.MALFORMED', TOO_LARGE: 'INPUT.TOO_LARGE' }),
  AUTH: Object.freeze({ REJECTED: 'AUTH.REJECTED', FORBIDDEN: 'AUTH.FORBIDDEN' }),
  CONFIG: Object.freeze({ INVALID: 'CONFIG.INVALID', MISMATCH: 'CONFIG.MISMATCH', UNSUPPORTED: 'CONFIG.UNSUPPORTED' }),
  GRAPH: Object.freeze({ UNAVAILABLE: 'GRAPH.UNAVAILABLE', INTERNAL: 'GRAPH.INTERNAL', CLOSED: 'GRAPH.CLOSED' }),
  TRANSPORT: Object.freeze({ INDETERMINATE: 'TRANSPORT.INDETERMINATE', ABORTED: 'TRANSPORT.ABORTED' }),
} as const)

type Leaf<T> = T[keyof T]
export type FaultCode = Leaf<{ [N in keyof typeof FAULT_CODES]: Leaf<(typeof FAULT_CODES)[N]> }>

export interface Fault extends Error {
  readonly code: FaultCode
  /** Whether the same call, with the same key, may succeed. */
  readonly retryable: boolean
  readonly detail: Readonly<Record<string, unknown>>
}

const CODES: ReadonlySet<string> = new Set(Object.values(FAULT_CODES).flatMap((group) => Object.values(group)))

export function fault(code: FaultCode, message: string, options: { retryable?: boolean; detail?: Record<string, unknown>; cause?: unknown } = {}): Fault {
  const { cause } = options
  // A refusal of input is a TypeError too, as it was before there were codes.
  const error = code === FAULT_CODES.INPUT.MALFORMED ? new TypeError(message, cause === undefined ? undefined : { cause }) : new Error(message, cause === undefined ? undefined : { cause })
  return Object.assign(error, { code, retryable: options.retryable ?? false, detail: options.detail ?? {} })
}

export function isFault(error: unknown): error is Fault {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && CODES.has(error.code) && 'retryable' in error && typeof error.retryable === 'boolean' && 'detail' in error && typeof error.detail === 'object' && error.detail !== null
}

export function hasCode(error: unknown, code: FaultCode): error is Fault {
  return isFault(error) && error.code === code
}

/** Input of the wrong shape. Nothing was written. */
export const malformed = (message: string, detail: Record<string, unknown> = {}): Fault => fault(FAULT_CODES.INPUT.MALFORMED, message, { detail })

/**
 * A "no" of the domain on its way out of the code that found it. The calls
 * catch it and answer it as a value. Anything else that reads it sees input
 * that was refused.
 */
export interface Refused extends Fault {
  readonly refusal: { readonly reason: string } & Readonly<Record<string, unknown>>
}
export const refused = (message: string, refusal: Refused['refusal']): Refused => Object.assign(malformed(message), { refusal })
export const isRefused = (error: unknown): error is Refused => isFault(error) && 'refusal' in error
