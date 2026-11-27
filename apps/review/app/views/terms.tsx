import { useId, useRef, type ReactNode } from 'react'

/**
 * What the words of the screen mean: a name, a sentence or two, and for some a line of arithmetic.
 * These are the original screen's own definitions.
 */
export const HELP: Record<string, [string, string, string?]> = {
  linkedIds: ['Linked IDs', 'IDs joined into one person, including this one.'],
  strongest: ['Strongest link', 'The highest match score between this ID and another.'],
  separated: ['Separated', 'IDs marked as different people by a reviewer or another system. They are not joined, whatever they share.'],
  lastSeen: ['Last seen', 'The newest sighting of this ID.'],
  consent: ['Ad consent', 'The latest answer on ad measurement and ad personalization. It does not cover calls, texts or email.'],
  score: ['Match score', 'Confidence that two IDs belong to the same person. Each shared identifier adds evidence.', 'evidence = weight × (2 / IDs sharing it)^dilution × 0.5^(gap / half-life)\nscore = 1 − (1 − e₁) × (1 − e₂) × …'],
  evidence: ['Evidence', 'The shared identifiers behind the score. Each line shows the evidence it adds, how many IDs share it, and the time between sightings. Ignore removes an identifier from matching everywhere.'],
  links: ['Links', 'IDs that share identifiers with this one. Same person: joined. High confidence: meets the join threshold but is held separate by a clustering rule. Related: below the join threshold.'],
  graph: ['Graph', 'This ID and the IDs linked to it. Select an ID to see its links. The slider hides links below a score.'],
  sightings: ['Sightings', 'Each time this ID was seen with an identifier, such as a login, a visit or a call. Links are computed from sightings.'],
  transfers: ['Transfers', 'Value sent and received between this ID and others, with how each is linked to it.'],
  rings: ['Circular transfers', 'Value that returned to this ID through other IDs. Transfers between linked IDs can indicate collusion.'],
  largest: ['Largest groups', 'People with the most linked IDs. Check large groups first: one widely shared identifier can join different people.'],
  audit: ['Audit log', 'Every join, separation, ignored identifier and deletion, with its author and reason. Each entry includes the hash of the one before it, so a changed entry fails verification.'],
  journeyIds: ['IDs', 'The IDs this timeline is read from: those joined to this person, and those linked strongly enough to share attribution.'],
  board: ['Board', 'Each person appears once. Unreturned missed calls come first. Everyone else is at the furthest step they reached.'],
  overdue: ['Overdue', 'People who have waited longer than the limit for their column. The age on a card is total elapsed time.'],
  advanced: ['Advanced today', 'People who reached a later step today, or whose missed call was returned.'],
  textsColumn: ['Unanswered texts', 'People whose text has had no reply by text or answered call. They are also counted at their step.'],
  missedColumn: ['Missed calls', 'People with a missed call that has not been returned. They move on when they are reached or call again and get through.'],
  pending: ['Pending', 'Pairs that share identifiers and have not been joined or separated.'],
  checked: ['IDs checked', 'IDs in the newest 10,000 sightings. Pairs not seen in those sightings are not listed.'],
  confident: ['High confidence', 'Pairs that meet the join threshold and were held separate by a clustering rule: one weak link between two groups, or a separation inside the group.'],
  possible: ['Possible', 'Pairs that score between the related and join thresholds.'],
  inbound: ['Inbound calls', 'Calls received in this period, excluding those marked as not a lead.'],
  answered: ['Answered', 'Calls your phone system reports as answered by a person.'],
  answeredLength: ['Answered', 'Calls reported as answered, or long enough to count as answered when no result was sent.'],
  missed: ['Missed', 'Calls that reached no one, including voicemails.'],
  afterHours: ['After hours', 'Calls that started outside your opening hours.'],
  returned: ['Returned', 'Missed callers who have been reached since: you called and they answered, or another system reported it.', 'returned ÷ (missed + voicemail)'],
  awaiting: ['Awaiting callback', 'Missed callers who have not been reached. Callers who withheld their number are excluded.'],
  callerId: ['Caller ID', 'A one-way hash of the phone number. To call back, find this call in your phone system by its time.'],
  callResults: ['Call results', 'Returned and Called again are shares of missed calls and voicemails. Other rows are shares of all inbound calls.'],
  attribution: ['Call attribution', 'Visitor: matched by a tracking number or a tap on your site. Phone number: the dialed number belongs to a channel. Unmatched: neither.'],
  heat: ['Calls by hour', 'Calls by weekday and starting hour. Blank cells had no calls.'],
  spend: ['Spend', 'Ad cost reported by each platform. Days without a cost record are counted as missing, not as zero.'],
  value: ['Value', 'Current value of the outcomes recorded in this period, net of refunds and write-offs.'],
  people: ['People', 'Unique people with an outcome. One person with several outcomes counts once.'],
  clicks: ['Clicks', 'Clicks billed by the ad platform.'],
  visits: ['Visits', 'Visits to your site that arrived from this campaign.'],
  cost: ['Cost per outcome', 'Average spend for each attributed outcome, using days that have cost data. Hidden when fewer than half the days have it.', 'spend ÷ outcomes'],
  roas: ['ROAS', 'Return on ad spend, using days that have cost data. Hidden when fewer than half the days have it.', 'value ÷ spend'],
  campaigns: ['Campaigns', 'Outcomes count on the day they happen and go to the latest qualifying visit. Outcomes marked as not a lead are excluded.'],
  breakdown: ['Breakdown', 'Splits outcomes within each campaign. Spend, clicks and visits are reported per campaign and cannot be split.'],
  reported: ['Platform-reported conversions', 'Conversions the ad platform claims, beside those attributed here on the same days. Platforms apply their own attribution rules, and two platforms can claim the same conversion.'],
  delay: ['Time to convert', 'Days from the latest visit to the outcome, for outcomes with a visit in the previous year. Outcomes outside the attribution window are counted here and stay unattributed.'],
  changes: ['Value changes', 'Initial value is the first amount recorded for an outcome. Current value reflects every update since.'],
  followed: ['Call outcomes', 'How many callers reached a step, grouped by what happened on the call. These are correlations: callers choose when to call, and staff choose whom to call back. Groups below the minimum size are hidden.'],
  callback: ['Callback', 'Counting starts one day after the missed call, whether or not it was returned. People who converted or got through on their own within that day are excluded.'],
  issues: ['Issues', 'Conditions that need attention, listed below.'],
  record: ['Audit log', 'Verified: every entry matches the hash chain. Altered: an entry was changed after it was written.'],
  policy: ['Matching policy', 'The active matching rules, identified by their hash. A changed policy takes effect after a rebuild.'],
  queued: ['Queued', 'Conversions waiting to be sent. Held conversions wait for a call result.'],
  sent: ['Sent', 'Conversions accepted by an ad platform. Skipped conversions were not eligible. Rejected conversions need a fix before they are retried.'],
  alerts: ['Alerts', 'Notifications posted to the ALERT_WEBHOOK address.'],
  feeds: ['Feeds', 'Incoming data sources. A monitored feed is stale when it sends no records for its limit.'],
  conversions: ['Conversions', 'Outcomes sent to ad platforms, by status, for all time.'],
  rejected: ['Rejected conversions', 'The platform returned a permanent error. Fix the cause it gives, then retry.'],
  pool: ['Tracking numbers', 'Numbers shown to one visitor at a time, so a dialed call can be matched to that visit.'],
  rules: ['Matching rules', 'Weight is the evidence from one identifier that two IDs share at the same time. It falls as more IDs share it and as sightings grow apart.'],
  chain: ['Verification hash', 'Computed from every decision so far. Store a copy outside this database to detect a rewritten log.'],
  conflicts: ['Conflicting decisions', 'Pairs that systems have joined and separated in turn, three times or more. A separation takes precedence over a join.'],
}

/**
 * The mark that shows a definition. Resting the mouse on it shows it, and pressing it keeps it open.
 * The definition is in the page from the start, so pressing works before any script has loaded.
 * `more` is a sentence that depends on the data.
 */
export function Info({ id, more }: { id: string, more?: string }) {
  const key = useId()
  const box = useRef<HTMLSpanElement>(null)
  const pinned = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [name, text, formula] = HELP[id]!
  const shown = () => box.current?.matches(':popover-open')
  return <><button type="button" className="info" popoverTarget={key} popoverTargetAction="show" aria-label={'About ' + name} aria-describedby={key}
    onClick={() => { clearTimeout(timer.current); pinned.current = true }}
    onPointerEnter={event => {
      if (event.pointerType !== 'mouse' || shown()) return
      timer.current = setTimeout(() => { if (!shown()) box.current?.showPopover() }, 180)
    }}
    onPointerLeave={() => {
      clearTimeout(timer.current)
      if (!pinned.current && shown()) box.current?.hidePopover()
    }}><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 14.6a6.6 6.6 0 1 0 0-13.2a6.6 6.6 0 0 0 0 13.2ZM8 7.45v3.5M8 5.05h.01"/></svg></button>
    <span className="info-pop" id={key} popover="auto" role="tooltip" ref={box} onToggle={event => { if ((event as unknown as { newState: string }).newState === 'closed') pinned.current = false }}><b>{name}</b><span className="info-text">{text}{more && ' ' + more}</span>{formula && <code>{formula}</code>}</span></>
}

/** A term with its definition beside it. */
export function Term({ id, more, children }: { id: string, more?: string, children?: ReactNode }) {
  return <span className="term">{children ?? HELP[id]![0]}<Info id={id} more={more}/></span>
}
