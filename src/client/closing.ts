import { FAULT_CODES, fault } from '../contract/fault.ts'

const PATIENCE = 30_000

/** Counts the calls under way, refuses new ones once it is ending, and waits for those that were accepted. */
export function createGate() {
  const under = new Set<Promise<unknown>>()
  let ended = false
  return {
    get ended() {
      return ended
    },
    run<T>(work: () => Promise<T>): Promise<T> {
      if (ended) return Promise.reject(fault(FAULT_CODES.GRAPH.CLOSED, 'This instance is closed'))
      const mine = work()
      const held = mine.catch(() => undefined).finally(() => under.delete(held))
      under.add(held)
      return mine
    },
    /** Resolves once nothing is under way, or patience is out. */
    async end(): Promise<void> {
      ended = true
      let timer: NodeJS.Timeout | undefined
      await Promise.race([Promise.all(under), new Promise((resolve) => void (timer = setTimeout(resolve, PATIENCE)))])
      clearTimeout(timer)
    },
  }
}
