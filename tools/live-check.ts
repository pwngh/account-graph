/**
 * Calls each vendor's real endpoint with an invalid key, to confirm the
 * address, the way the key is sent, and how a refusal is read. Sends no real data.
 *   node tools/live-check.ts
 */
import { generateKeyPairSync } from 'node:crypto'
import { ingest, ingestRequest, meta } from '../src/index.ts'
import { createFingerprintVerifier } from '../src/integrations/fingerprint.ts'
import { createGoogleTokens } from '../src/integrations/google-auth.ts'
import { createMaxMindLookup } from '../src/integrations/maxmind.ts'

const show = async (name: string, work: () => Promise<unknown>) => {
  try {
    console.log(`${name}: answered ${JSON.stringify(await work())}`)
  } catch (error) {
    console.log(`${name}: ${String((error as Error).message).replace(/\s+/g, ' ').slice(0, 220)}`)
  }
}
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const key = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const job = { transactionId: 't', target: 'meta', subject: 's', at: Date.now(), action: 'Lead', keys: { em: 'a'.repeat(64) }, state: 'pending' as const, attempts: 1, due: 0 }

await show('fingerprint', () => createFingerprintVerifier({ secretKey: 'invalid' })('1708102555327.NLOjmg'))
await show('maxmind', () => createMaxMindLookup({ accountId: 1, licenseKey: 'invalid' })('8.8.8.8'))
await show('google token', () => createGoogleTokens({ client_email: 'nobody@example-not-real.iam.gserviceaccount.com', private_key: key })())
await show('google data manager', () => ingest(ingestRequest({ customerId: '1234567890', conversionActionId: '1' }, [{ transactionId: 't', at: Date.now(), click: { gclid: 'x' } }]), 'invalid'))
const target = meta({ pixelId: '1', accessToken: 'invalid', url: 'https://example.org/' })
await show('meta', async () => {
  try {
    return await target.deliver('Lead', [{ job, touch: undefined, consent: undefined }])
  } catch (error) {
    throw new Error(`${(error as Error).message} | retry later: ${target.retryable(error)}`)
  }
})
