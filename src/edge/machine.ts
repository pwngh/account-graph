import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

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
  if (!id) throw new Error(`Cannot read a machine ID on ${platform}`)
  return id.toLowerCase()
}
