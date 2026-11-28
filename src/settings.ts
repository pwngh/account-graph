/** Every setting the server reads, and what its value must be. A name that is not here is not read. */
export const SETTINGS = {
  // Where and who.
  DATABASE_URL: 'text', GRAPH_SCHEMA: 'text', PORT: 'number', HOST: 'text', ORIGINS: 'text', TRUST_PROXY: 'text', COOKIE: 'text',
  GRAPH_TOKEN: 'text', REVIEW_TOKENS: 'text', SERVICE_TOKENS: 'text', SERVICE_TOKENS_FILE: 'text', STAFF_NETWORKS: 'text',
  RECEIPT_SECRETS: 'text', IDENTIFIER_SECRET: 'text', LINK_SECRET: 'text',
  RATE_LIMIT: 'text', RATE_PER_MINUTE: 'number', RATE_BURST: 'number',
  ALLOW_PAGES: 'text', REFUSE_PAGES: 'text', SERVER_RANGES_FILE: 'text',
  POLICY: 'text', POLICY_FILE: 'text', REPORT_TIME_ZONE: 'text', MESSAGE_DAYS: 'number',
  // What arrives.
  EVENTS: 'text', STAGES: 'text', TARGETS: 'text', LEADS: 'text', LEADS_FILE: 'text', OPEN_HOURS: 'text',
  CALL_NUMBERS: 'text', CALL_NUMBERS_FILE: 'text', CALL_EXCLUDE: 'text', CALL_MIN_SECONDS: 'number', CALL_TAP_SECONDS: 'number',
  CALL_RESULTS: 'text', CALL_RESULT_WAIT: 'number', RETURN_HOURS: 'number', TEXT_CODES: 'flag',
  POOL_NUMBERS: 'text', POOL_MINUTES: 'number', POOL_GRACE_MINUTES: 'number', POOL_REQUIRE_TAP_AFTER_REASSIGNMENT: 'flag',
  TWILIO_ACCOUNT_SID: 'text', TWILIO_AUTH_TOKEN: 'text', TWILIO_WEBHOOK_URL: 'text', TWILIO_TEXT_WEBHOOK_URL: 'text',
  // What goes out, and who is told.
  OUTBOX_DELAY_MS: 'number', PAUSE_AFTER_FAILURES: 'number', FORGET_ADS: 'flag',
  WEBHOOK_URL: 'text', WEBHOOK_SECRET: 'text', ALERT_WEBHOOK: 'text', AUDIT_HEAD_HOURS: 'number', LATE_HOURS: 'number', REVIEW_PENDING_LIMIT: 'number',
  QUIET_TOUCHES_HOURS: 'number', QUIET_CALLS_HOURS: 'number', QUIET_RESULTS_HOURS: 'number', QUIET_COSTS_HOURS: 'number',
  // Providers.
  GOOGLE_ADS_CUSTOMER_ID: 'text', GOOGLE_ADS_LOGIN_CUSTOMER_ID: 'text', GOOGLE_SERVICE_ACCOUNT_FILE: 'text', GOOGLE_ADS_DEVELOPER_TOKEN: 'text', GOOGLE_ADS_COSTS: 'flag', GOOGLE_ADS_CONVERSIONS: 'flag',
  META_PIXEL_ID: 'text', META_ACCESS_TOKEN: 'text', META_SITE_URL: 'text', META_TEST_EVENT_CODE: 'text', META_CLIENT_USER_AGENT: 'flag',
  META_AD_ACCOUNT_ID: 'text', META_ADS_TOKEN: 'text', META_ADS_CONVERSIONS: 'text',
  MICROSOFT_CLIENT_ID: 'text', MICROSOFT_REFRESH_TOKEN: 'text', MICROSOFT_CLIENT_SECRET: 'text', MICROSOFT_DEVELOPER_TOKEN: 'text', MICROSOFT_CUSTOMER_ID: 'text', MICROSOFT_ACCOUNT_ID: 'text', MICROSOFT_SANDBOX: 'flag',
  TIKTOK_PIXEL_CODE: 'text', TIKTOK_ACCESS_TOKEN: 'text', TIKTOK_SITE_URL: 'text', TIKTOK_TEST_EVENT_CODE: 'text',
  SMARTY_AUTH_ID: 'text', SMARTY_AUTH_TOKEN: 'text', SMARTY_LICENSE: 'text',
  MAXMIND_ACCOUNT_ID: 'text', MAXMIND_LICENSE_KEY: 'text', MAXMIND_SERVICE: 'text', MAXMIND_HOST: 'text',
  FINGERPRINT_SECRET: 'text', FINGERPRINT_REGION: 'text',
  ADS_TEST_RECEIVER: 'text',
} as const satisfies Record<string, 'text' | 'number' | 'flag'>

/** Names that were settings once. The server says what took their place. */
const RETIRED: Record<string, string> = { CHANGE_WEBHOOK: 'WEBHOOK_URL', CHANGE_SECRET: 'WEBHOOK_SECRET' }

/** Whether one name is the other with one letter added, dropped or changed, or two next to each other swapped. */
function oneOff(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2))
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

/** Names a container platform makes for the services beside it, such as `MAXMIND_PORT` or `REDIS_SERVICE_HOST`. */
const PLATFORM = /_(PORT|SERVICE_HOST|SERVICE_PORT)(_|$)/

/**
 * What is wrong with the settings as named and typed: a flag that is not `true` or `false`, even one whose feature is off, a retired
 * name, and a name that is a setting with one letter wrong or in another case, such as `FORGET_ADD` or `forget_ads`. Other names, such as
 * `HOME`, `NODE_VERSION` or `DATABASE_SSL`, are nobody's business.
 */
export function settingProblems(env: Readonly<Record<string, string | undefined>>, platform: string = process.platform): string[] {
  const wrong: string[] = []
  const known = Object.keys(SETTINGS)
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === '') continue
    const kind = (SETTINGS as Record<string, string>)[name]
    if (kind === 'flag' && value !== 'true' && value !== 'false') wrong.push(`${name} must be true or false`)
    if (kind !== undefined) continue
    if (Object.hasOwn(RETIRED, name)) wrong.push(`${name} is now ${RETIRED[name]}`)
    else if (name.includes('_') && name.length >= 8 && !PLATFORM.test(name)) {
      // Windows reads a name in any case, so there a name in another case is the setting itself.
      const near = (platform === 'win32' ? undefined : known.find((each) => each === name.toUpperCase())) ?? known.find((each) => oneOff(each, name))
      if (near) wrong.push(`${name} is not a setting. Did you mean ${near}?`)
    }
  }
  return wrong
}
