import type { Graph } from './graph.ts'
import type { Change, Observation } from './types.ts'

export interface Batcher {
  /**
   * Queues an observation and resolves once it is written. Resolves to the
   * cluster changes of the write that carried it, which may include changes
   * caused by other observations in the same write.
   */
  observe(observation: Observation): Promise<Change[]>
  /** Resolves when everything queued so far is written. */
  drain(): Promise<void>
}

interface Waiting {
  observation: Observation
  resolve(changes: Change[]): void
  reject(error: unknown): void
}

/**
 * Queues observations and writes them in groups. While one write is in
 * flight, arrivals wait and then go together in the next, so a quiet system
 * writes at once and a busy one writes in batches. Nothing is delayed on a timer.
 */
export function createBatcher(graph: Graph, max = 500): Batcher {
  let queue: Waiting[] = []
  let flushing: Promise<void> | undefined

  async function flush(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.slice(0, max)
      queue = queue.slice(max)
      try {
        const changes = await graph.observe(batch.map((waiting) => waiting.observation))
        for (const waiting of batch) waiting.resolve(changes)
      } catch {
        // One bad observation refuses the whole write. Write each alone so only its caller hears of it.
        for (const waiting of batch) await graph.observe(waiting.observation).then(waiting.resolve, waiting.reject)
      }
    }
  }

  return {
    observe(observation) {
      return new Promise((resolve, reject) => {
        queue.push({ observation, resolve, reject })
        flushing ??= flush().finally(() => (flushing = undefined))
      })
    },
    async drain() {
      while (flushing) await flushing
    },
  }
}
