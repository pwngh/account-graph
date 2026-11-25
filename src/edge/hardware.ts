/**
 * Runs in a desktop client: Node, or the main process of Electron. Reads the
 * id the operating system keeps for this machine.
 */
import { malformed } from '../contract/fault.ts'
import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { Identifier } from '../contract/types.ts'

const run = promisify(execFile)

/**
 * The operating system's own machine id. It survives reinstalling your app
 * and clearing its data, and changes when the system is reinstalled.
 *
 * - macOS: `IOPlatformUUID` from the I/O registry.
 * - Windows: `MachineGuid` from the registry, read with the `reg.exe` of `windows`. `wmic` is gone from current Windows.
 * - Linux: `/etc/machine-id`.
 */
export async function machineId(platform: NodeJS.Platform = process.platform, windows = 'C:\\Windows'): Promise<string> {
  let id: string | undefined
  if (platform === 'darwin') {
    const { stdout } = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
    id = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1]
  } else if (platform === 'win32') {
    const reg = `${windows}\\System32\\reg.exe`
    const { stdout } = await run(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'])
    id = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(stdout)?.[1]
  } else {
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      id = (await readFile(file, 'utf8').catch(() => '')).trim()
      if (id) break
    }
  }
  if (!id) throw new Error(`Cannot read a machine id on ${platform}`)
  return id.toLowerCase()
}

/**
 * The hardware identifier to send with a login. The raw machine id never
 * leaves the machine: it is hashed with `salt`, a constant of your app, so
 * the value is useless to any other app that reads the same machine id.
 */
export async function hardwareId(salt: string, platform?: NodeJS.Platform, windows?: string): Promise<Identifier> {
  if (!salt) throw malformed('hardwareId requires a salt that is constant for your app')
  return `hardware:${createHmac('sha256', salt).update(await machineId(platform, windows)).digest('hex')}`
}
