import { FAULT_CODES, fault, isFault, malformed } from '../contract/fault.ts'
import type { Fault } from '../contract/fault.ts'

const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])
/** SQLSTATEs that mean the database could not take it now. */
const BUSY = /^(08|53|57P|40001|40P01|55P03|57014)/

/** Whatever was thrown, as the fault it is. What a program error says is kept as its cause and never shown. */
export function asFault(error: unknown): Fault {
  if (isFault(error)) return 'refusal' in error ? malformed(error.message) : error
  if (error instanceof Error && error.name === 'AbortError') return fault(FAULT_CODES.TRANSPORT.ABORTED, 'The call was aborted', { cause: error })
  const { code, committing, errors } = (error ?? {}) as { code?: unknown; committing?: boolean; errors?: { code?: unknown }[] }
  if (committing) return fault(FAULT_CODES.TRANSPORT.INDETERMINATE, 'The connection was lost as the write was committed', { retryable: true, cause: error })
  const codes = [code, ...(Array.isArray(errors) ? errors.map((each) => each?.code) : [])].map(String)
  const message = error instanceof Error ? error.message : ''
  if (codes.some((each) => NETWORK.has(each) || BUSY.test(each)) || /^Connection terminated|^timeout exceeded when trying to connect|Client has encountered a connection error/.test(message)) return fault(FAULT_CODES.GRAPH.UNAVAILABLE, 'The database is not available', { retryable: true, cause: error })
  return fault(FAULT_CODES.GRAPH.INTERNAL, 'Internal error', { cause: error })
}

/** The status each fault is answered with. */
export const STATUS: Readonly<Record<string, number>> = {
  [FAULT_CODES.INPUT.MALFORMED]: 400, [FAULT_CODES.INPUT.TOO_LARGE]: 413, [FAULT_CODES.AUTH.REJECTED]: 401, [FAULT_CODES.AUTH.FORBIDDEN]: 403,
  [FAULT_CODES.CONFIG.INVALID]: 500, [FAULT_CODES.CONFIG.MISMATCH]: 503, [FAULT_CODES.CONFIG.UNSUPPORTED]: 422,
  [FAULT_CODES.GRAPH.UNAVAILABLE]: 503, [FAULT_CODES.GRAPH.INTERNAL]: 500, [FAULT_CODES.GRAPH.CLOSED]: 503,
  [FAULT_CODES.TRANSPORT.INDETERMINATE]: 504, [FAULT_CODES.TRANSPORT.ABORTED]: 499,
}

export const faultBody = ({ code, message, retryable, detail }: Fault) => ({ fault: { code, message, retryable, detail } })
