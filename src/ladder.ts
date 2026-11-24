import type { Outcome } from './types.ts'

/** What one step is worth, and what it counts as on each ad platform. */
export interface Stage {
  /** The value an outcome of this step has when it names none. */
  value?: number
  currency?: string
  /** How many hours a person may stand at this step before the board says they have waited too long. Left out or 0, it never does. */
  wait?: number
  /** What the step counts as on each ad platform, by target name: `{ google: '987654321', meta: 'Lead' }`. */
  action?: string | Record<string, string>
}

/**
 * The steps a person can take on the way to becoming a customer, in order,
 * each with what it is worth: an inquiry 5, a call 10, a sale 200.
 */
export type Ladder = Readonly<Record<string, Stage>>

/**
 * An outcome with what its step says filled in. What the outcome states
 * itself always stands; the step only supplies what was left out.
 */
export function withStage(ladder: Ladder | undefined, outcome: Outcome): Outcome {
  const stage = typeof outcome?.stage === 'string' && ladder && Object.hasOwn(ladder, outcome.stage) ? ladder[outcome.stage] : undefined
  if (!stage) return outcome
  return {
    ...outcome,
    ...(outcome.value === undefined && stage.value !== undefined && { value: stage.value }),
    ...(outcome.currency === undefined && stage.currency !== undefined && { currency: stage.currency }),
    ...(outcome.action === undefined && stage.action !== undefined && { action: stage.action }),
  }
}

/** What is wrong with a ladder read from a setting, one line each. `targets` are the ad platforms that are set up. */
export function ladderProblems(ladder: unknown, targets: readonly string[]): string[] {
  if (!ladder || typeof ladder !== 'object' || Array.isArray(ladder)) return ['must be an object of steps, such as {"inquiry":{"value":5}}']
  const wrong: string[] = []
  for (const [name, stage] of Object.entries(ladder as Record<string, any>)) {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      wrong.push(`step "${name}" must be an object, such as {"value":5}`)
      continue
    }
    if (stage.value !== undefined && (typeof stage.value !== 'number' || !Number.isFinite(stage.value) || stage.value < 0)) wrong.push(`step "${name}" requires a value of zero or more`)
    if (stage.currency !== undefined && typeof stage.currency !== 'string') wrong.push(`step "${name}" requires its currency as a string`)
    if (stage.wait !== undefined && (typeof stage.wait !== 'number' || !Number.isFinite(stage.wait) || stage.wait < 0)) wrong.push(`step "${name}" requires its wait as hours, zero or more`)
    const { action } = stage
    if (action === undefined) continue
    const named = typeof action === 'string' ? undefined : action && typeof action === 'object' && !Array.isArray(action) ? Object.entries(action) : null
    if (named === null || (typeof action === 'string' && !action) || named?.some(([, each]) => typeof each !== 'string' || !each)) {
      wrong.push(`step "${name}" requires its action as a string, or as one text per platform`)
    } else if (targets.length === 0) {
      wrong.push(`step "${name}" has an action, but no ad platform is set up to send it to`)
    } else if (named === undefined) {
      if (targets.length > 1) wrong.push(`step "${name}" must name its action per platform, such as {"${targets[0]}":"…"}`)
    } else {
      for (const [target] of named) if (!targets.includes(target)) wrong.push(`step "${name}" names "${target}", which is not set up`)
    }
  }
  return wrong
}
