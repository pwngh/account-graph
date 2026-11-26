/**
 * Runs in a desktop client: Node, or the main process of Electron. Reads the
 * id the operating system keeps for this machine.
 */
import { malformed } from '../contract/fault.ts'
import { createHmac } from 'node:crypto'
import { machineId } from './machine.ts'
import type { Identifier } from '../contract/types.ts'

/**
 * The hardware identifier to send with a login. The raw machine id never
 * leaves the machine. It is hashed with `salt`, a constant of your app, so
 * the value is useless to any other app that reads the same machine id.
 */
export async function hardwareId(salt: string, platform?: NodeJS.Platform, windows?: string): Promise<Identifier> {
  if (!salt) throw malformed('hardwareId requires a salt that is constant for your app')
  return `hardware:${createHmac('sha256', salt).update(await machineId(platform, windows)).digest('hex')}`
}
