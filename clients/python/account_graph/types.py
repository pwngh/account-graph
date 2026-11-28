"""Types for JSON requests and responses. Field names follow src/contract/api.ts."""

from typing import Literal, Optional, TypedDict, Union


At = int
Direction = Literal["inbound", "outbound"]
DeliveryState = Literal["held", "pending", "sent", "skipped", "failed"]
CallState = Literal["answered", "missed", "voicemail", "waiting", "unknown"]
Level = Literal["same", "related"]
Relation = Literal["same", "related", "none"]
Channel = Literal["WEB", "APP", "IN_STORE", "PHONE", "MESSAGE", "OTHER", "SYSTEM_GENERATED"]


class Consent(TypedDict):
    adUserData: bool
    adPersonalization: bool


class _AddressOptions(TypedDict, total=False):
    street2: str
    secondary: str
    city: str
    state: str
    zipcode: str


class Address(_AddressOptions):
    street: str


class Name(TypedDict):
    first: str
    last: str


class Facts(TypedDict, total=False):
    email: str
    phone: str
    device: str
    ip: str
    address: Address
    name: Name
    dob: str
    identifiers: list[str]


class Speaker(TypedDict, total=False):
    device: str
    phone: str
    email: str


class _Keyed(TypedDict):
    key: str
    at: At


class _ProfileEntryOptions(TypedDict, total=False):
    createdAt: At
    event: str
    speaker: Speaker


class ProfileEntry(_Keyed, _ProfileEntryOptions):
    type: Literal["profile"]
    subject: str
    facts: Facts


class Clicks(TypedDict, total=False):
    gclid: str
    gbraid: str
    wbraid: str
    fbclid: str
    fbp: str
    msclkid: str
    ttclid: str


class _ArrivalEntryOptions(TypedDict, total=False):
    source: str
    medium: str
    campaign: str
    campaignId: str
    adGroupId: str
    adId: str
    term: str
    content: str
    landing: str
    referrer: str
    clicks: Clicks
    custom: dict[str, str]


class ArrivalEntry(_Keyed, _ArrivalEntryOptions):
    type: Literal["arrival"]
    subject: str


class _CostRowOptions(TypedDict, total=False):
    campaignId: str
    campaign: str
    clicks: int
    impressions: int
    conversions: float
    conversionValue: float


class CostRow(_CostRowOptions):
    day: str
    source: str
    amount: float
    currency: str


class CostEntry(_Keyed):
    type: Literal["cost"]
    rows: list[CostRow]


class _ConversionEntryOptions(TypedDict, total=False):
    value: float
    currency: str
    actions: dict[str, str]
    userAgent: str
    channel: Channel
    email: str
    phone: str
    consent: Consent
    tags: dict[str, str]


class ConversionEntry(_Keyed, _ConversionEntryOptions):
    type: Literal["conversion"]
    subject: str
    stage: str


class RecordReference(TypedDict):
    type: Literal["call", "text", "conversion"]
    key: str


class _Currency(TypedDict, total=False):
    currency: str


class Correction(_Currency):
    kind: Literal["correct"]
    value: float


class Loss(_Currency):
    kind: Literal["refund", "write_off"]
    amount: float


class Reversal(TypedDict):
    kind: Literal["reverse"]
    restatement: str


class _Signed(TypedDict, total=False):
    """Who says so. A reviewer signs their own name, and a named service its own."""

    by: str


class NotLead(_Signed):
    kind: Literal["not_lead"]
    why: Literal["spam", "other"]


class Lead(_Signed):
    kind: Literal["lead"]


class RestatementEntry(_Keyed):
    type: Literal["restatement"]
    of: RecordReference
    change: Union[Correction, Loss, Reversal, NotLead, Lead]


class PaymentEntry(_Keyed, _Currency):
    type: Literal["payment"]
    conversion: str
    direction: Literal["received", "refunded"]
    amount: float


class _CallResultOptions(TypedDict, total=False):
    voicemail: bool
    waited: float


class CallResult(_CallResultOptions):
    answered: bool


_CallEntryOptions = TypedDict("_CallEntryOptions", {"from": str, "duration": float, "result": CallResult, "code": str, "tags": dict[str, str]}, total=False)


class CallEntry(_Keyed, _CallEntryOptions):
    type: Literal["call"]
    direction: Direction
    to: str


class ResultChange(TypedDict):
    kind: Literal["result"]
    result: CallResult


class ReturnedChange(_Signed):
    kind: Literal["returned"]
    reachedAt: At


class NotReturnedChange(_Signed):
    kind: Literal["not_returned"]


class __PartyChangeOptions(TypedDict, total=False):
    seen: Optional[str]


class _PartyChange(__PartyChangeOptions):
    kind: Literal["party"]
    by: str


class KnownParty(TypedDict):
    role: Literal["self", "representative", "excluded"]
    subject: str


class UnknownParty(TypedDict):
    role: Literal["unknown"]


class KnownPartyChange(_PartyChange, KnownParty):
    pass


class UnknownPartyChange(_PartyChange, UnknownParty):
    pass


class CallUpdateEntry(_Keyed):
    type: Literal["call_update"]
    call: str
    change: Union[ResultChange, ReturnedChange, NotReturnedChange, KnownPartyChange, UnknownPartyChange]


_From = TypedDict("_From", {"from": str})


class _TextEntryOptions(TypedDict, total=False):
    text: str
    code: str
    tags: dict[str, str]


class TextEntry(_Keyed, _From, _TextEntryOptions):
    type: Literal["text"]
    direction: Direction
    to: str


class _ConsentEntryOptions(TypedDict, total=False):
    source: str


class ConsentEntry(_Keyed, _ConsentEntryOptions):
    type: Literal["consent"]
    subject: str
    consent: Consent


class _LinkEntryOptions(TypedDict, total=False):
    purpose: str


class LinkEntry(_Keyed, _LinkEntryOptions):
    type: Literal["link"]
    subject: str
    url: str
    expires: At


class _TransferEntryOptions(TypedDict, total=False):
    asset: str


class TransferEntry(_Keyed, _From, _TransferEntryOptions):
    type: Literal["transfer"]
    to: str
    amount: int


RecordType = Literal["profile", "arrival", "cost", "conversion", "restatement", "payment", "call", "call_update", "text", "consent", "link", "transfer"]
RecordEntry = Union[ProfileEntry, ArrivalEntry, CostEntry, ConversionEntry, RestatementEntry, PaymentEntry, CallEntry, CallUpdateEntry, TextEntry, ConsentEntry, LinkEntry, TransferEntry]


class RecordRequest(TypedDict):
    entries: list[RecordEntry]


_ChangeOptions = TypedDict("_ChangeOptions", {"from": str, "to": str}, total=False)


class Change(_ChangeOptions):
    subject: str


class Told(TypedDict):
    duplicate: bool
    stands: bool


class _Note(TypedDict, total=False):
    note: str


class Delivery(_Note):
    conversion: str
    platform: str
    state: DeliveryState


class _FollowUpOptions(TypedDict, total=False):
    by: str
    delay: int
    reported: Literal[True]


class FollowUp(_FollowUpOptions):
    state: Literal["open", "returned", "called again", "hidden"]
    attempts: int


class _TextReplyOptions(TypedDict, total=False):
    by: str
    how: Literal["text", "call"]
    delay: int


class TextReply(_TextReplyOptions):
    state: Literal["open", "replied", "stopped"]


class ProfileValue(Told):
    changes: list[Change]
    notes: dict[str, str]


class ArrivalValue(Told):
    subject: str


class CostValue(Told):
    written: int
    older: int


class ConversionValue(Told):
    value: float
    currency: str
    deliveries: list[Delivery]


class PaymentValue(Told):
    value: Optional[float]
    deliveries: list[Delivery]


class RestatementValue(PaymentValue):
    counts: bool


class _CallValueOptions(TypedDict, total=False):
    visitor: str


class CallValue(Told, _CallValueOptions):
    subject: str
    state: CallState
    counted: bool
    flags: list[str]


class CallUpdateValue(Told):
    state: CallState
    counted: bool
    followUp: Optional[FollowUp]


class _TextValueOptions(TypedDict, total=False):
    visitor: str
    optOutAdded: Literal[True]


class TextValue(Told, _TextValueOptions):
    subject: str
    flags: list[str]
    counted: bool


class ConsentValue(Told, Consent):
    pass


class LinkValue(Told):
    url: str


class TransferValue(Told):
    relation: Relation
    score: float


class _RecordAccepted(TypedDict):
    ok: Literal[True]
    key: str


class ProfileAccepted(_RecordAccepted):
    type: Literal["profile"]
    value: ProfileValue


class ArrivalAccepted(_RecordAccepted):
    type: Literal["arrival"]
    value: ArrivalValue


class CostAccepted(_RecordAccepted):
    type: Literal["cost"]
    value: CostValue


class ConversionAccepted(_RecordAccepted):
    type: Literal["conversion"]
    value: ConversionValue


class RestatementAccepted(_RecordAccepted):
    type: Literal["restatement"]
    value: RestatementValue


class PaymentAccepted(_RecordAccepted):
    type: Literal["payment"]
    value: PaymentValue


class CallAccepted(_RecordAccepted):
    type: Literal["call"]
    value: CallValue


class CallUpdateAccepted(_RecordAccepted):
    type: Literal["call_update"]
    value: CallUpdateValue


class TextAccepted(_RecordAccepted):
    type: Literal["text"]
    value: TextValue


class ConsentAccepted(_RecordAccepted):
    type: Literal["consent"]
    value: ConsentValue


class LinkAccepted(_RecordAccepted):
    type: Literal["link"]
    value: LinkValue


class TransferAccepted(_RecordAccepted):
    type: Literal["transfer"]
    value: TransferValue


RecordAccepted = Union[ProfileAccepted, ArrivalAccepted, CostAccepted, ConversionAccepted, RestatementAccepted, PaymentAccepted, CallAccepted, CallUpdateAccepted, TextAccepted, ConsentAccepted, LinkAccepted, TransferAccepted]


class _Refused(TypedDict):
    ok: Literal[False]


class KeyReused(_Refused):
    reason: Literal["KEY_REUSED"]
    fields: list[str]


class Forgotten(_Refused):
    reason: Literal["FORGOTTEN"]


class KindNotInPolicy(_Refused):
    reason: Literal["KIND_NOT_IN_POLICY"]
    kind: str


class _RecordRefused(TypedDict):
    type: RecordType
    key: str


class RecordKeyReused(_RecordRefused, KeyReused):
    pass


class RecordForgotten(_RecordRefused, Forgotten):
    pass


class RecordKindNotInPolicy(_RecordRefused, KindNotInPolicy):
    pass


class MissingReference(TypedDict):
    type: Literal["conversion", "call", "text", "restatement"]
    key: str


class RecordStale(_RecordRefused, _Refused):
    reason: Literal["STALE"]
    decision: Optional[str]
    by: Optional[str]
    at: Optional[At]


class UnknownReference(_RecordRefused, _Refused):
    reason: Literal["UNKNOWN_REFERENCE"]
    of: MissingReference


class KindReserved(_RecordRefused, _Refused):
    reason: Literal["KIND_RESERVED"]
    kind: str


class NoFactUsed(_RecordRefused, _Refused):
    reason: Literal["NO_FACT_USED"]
    notes: dict[str, str]


class CurrencyMismatch(_RecordRefused, _Refused):
    reason: Literal["CURRENCY_MISMATCH"]
    expected: str


class Paid(_RecordRefused, _Refused):
    reason: Literal["PAID"]


class NotAttempted(_RecordRefused, _Refused):
    reason: Literal["NOT_ATTEMPTED"]


RecordRefusal = Union[RecordKeyReused, RecordForgotten, RecordKindNotInPolicy, RecordStale, UnknownReference, KindReserved, NoFactUsed, CurrencyMismatch, Paid, NotAttempted]
RecordResult = Union[RecordAccepted, RecordRefusal]


class RecordResponse(TypedDict):
    results: list[RecordResult]


# Decide and forget share the reviewer and the decision number they saw.
class _DecidingOptions(TypedDict, total=False):
    reason: str
    seen: int


class Deciding(_DecidingOptions):
    key: str
    at: At
    by: str


class _DecisionPairOptions(TypedDict, total=False):
    reason: str


class DecisionPair(_DecisionPairOptions):
    a: str
    b: str


class PairsDecision(Deciding):
    action: Literal["merge", "unmerge", "split", "unsplit"]
    pairs: list[DecisionPair]


class EmailFact(TypedDict):
    email: str


class PhoneFact(TypedDict):
    phone: str


class IpFact(TypedDict):
    ip: str


class IdentifierFact(TypedDict):
    identifier: str


class FactDecision(Deciding):
    action: Literal["mute", "unmute"]
    fact: Union[EmailFact, PhoneFact, IpFact, IdentifierFact]


DecideRequest = Union[PairsDecision, FactDecision]


class UnmetPair(TypedDict):
    a: str
    b: str
    because: Literal["split", "evidence", "other_merges"]


class _DecideValueOptions(TypedDict, total=False):
    stands: bool


class DecideValue(_DecideValueOptions):
    duplicate: bool
    changes: list[Change]
    recorded: int
    already: int
    notAsAsked: list[UnmetPair]


class DecideAccepted(TypedDict):
    ok: Literal[True]
    value: DecideValue


class StaleDecision(_Refused):
    reason: Literal["STALE"]
    decision: int
    by: Optional[str]
    at: At


class NotJoinedPair(TypedDict):
    a: str
    b: str
    because: Literal["apart", "evidence", "other_merges"]


class NotJoined(_Refused):
    reason: Literal["NOT_JOINED"]
    pairs: list[NotJoinedPair]


DecideRefusal = Union[StaleDecision, KeyReused, KindNotInPolicy, NotJoined, Forgotten]
DecideResponse = Union[DecideAccepted, DecideRefusal]


class ForgetRequest(Deciding):
    subjects: list[str]
    platforms: Literal["report", "retract"]


class SentConversion(_Note):
    conversion: str
    platform: str
    action: str
    at: At
    state: Literal["pending", "accepted", "rejected", "not_requested"]


class ForgetValue(TypedDict):
    duplicate: bool
    changes: list[Change]
    sent: list[SentConversion]


class ForgetAccepted(TypedDict):
    ok: Literal[True]
    value: ForgetValue


ForgetRefusal = Union[StaleDecision, KeyReused]
ForgetResponse = Union[ForgetAccepted, ForgetRefusal]


# Each lookup kind determines the type of the whole response.
class PersonRequest(TypedDict):
    kind: Literal["person"]
    subjects: list[str]
    at: At


class _JourneyRequestOptions(TypedDict, total=False):
    before: int


class JourneyRequest(_JourneyRequestOptions):
    kind: Literal["journey"]
    subject: str


class FindRequest(TypedDict):
    kind: Literal["find"]
    text: str


class MatchRequest(TypedDict):
    kind: Literal["match"]
    facts: Facts
    at: At


_CallerRequestOptions = TypedDict("_CallerRequestOptions", {"from": str}, total=False)


class CallerRequest(_CallerRequestOptions):
    kind: Literal["caller"]
    to: str
    at: At


class PartyRequest(TypedDict):
    kind: Literal["party"]
    call: str


class ConflictsRequest(TypedDict):
    kind: Literal["conflicts"]
    subjects: list[str]


class RecordLookupRequest(RecordReference):
    kind: Literal["record"]
    at: At


class _TransfersRequestOptions(TypedDict, total=False):
    tiedOnly: bool


class TransfersRequest(_TransfersRequestOptions):
    kind: Literal["transfers"]
    subject: str


LookupRequest = Union[PersonRequest, JourneyRequest, FindRequest, MatchRequest, CallerRequest, PartyRequest, ConflictsRequest, RecordLookupRequest, TransfersRequest]


class CampaignCredit(TypedDict):
    source: str
    campaign: Optional[str]
    campaignId: Optional[str]


How = Literal["self", "cluster", "linked"]


class Arrival(CampaignCredit):
    at: At
    landing: Optional[str]
    custom: dict[str, str]
    confidence: float
    how: How


class Tie(TypedDict):
    how: How
    score: Optional[float]
    via: list[str]
    kinds: list[str]


class Person(TypedDict):
    subject: str
    known: bool
    members: list[str]
    oversized: bool
    arrival: Optional[Arrival]
    possible: Optional[Arrival]
    consent: Optional[Consent]
    textsOptedOut: bool


class PersonValue(TypedDict):
    decisions: int
    people: list[Person]


class _AtSubject(TypedDict):
    at: At
    subject: str


class _PartyStatement(TypedDict):
    by: str
    at: At


class KnownPartyStatement(_PartyStatement, KnownParty):
    pass


class UnknownPartyStatement(_PartyStatement, UnknownParty):
    pass


PartyStatement = Union[KnownPartyStatement, UnknownPartyStatement]


class KnownPartyRecord(KnownPartyStatement):
    key: str


class UnknownPartyRecord(UnknownPartyStatement):
    key: str


class ExcludedParty(TypedDict):
    role: Literal["excluded"]
    by: str
    at: At
    key: str


PartyValue = Union[KnownPartyRecord, UnknownPartyRecord, ExcludedParty, None]
NotLeadReason = Optional[Literal["spam", "other"]]


class __CallViewOptions(TypedDict, total=False):
    party: PartyStatement


class _CallView(_AtSubject, __CallViewOptions):
    direction: Direction
    state: CallState
    followUp: Optional[FollowUp]
    notLead: NotLeadReason


class _TextView(_AtSubject):
    direction: Direction
    reply: Optional[TextReply]
    notLead: NotLeadReason


class JourneyVisit(_AtSubject):
    kind: Literal["visit"]
    arrival: Arrival


class JourneySighting(_AtSubject):
    kind: Literal["sighting"]
    event: str
    kinds: list[str]


class JourneyCall(_CallView):
    kind: Literal["call"]
    call: str


class JourneyText(_TextView):
    kind: Literal["text"]
    text: str


class JourneyLink(_AtSubject):
    kind: Literal["link"]
    link: str
    purpose: Optional[str]
    opened: Optional[At]
    openings: int


class JourneyConversion(_AtSubject):
    kind: Literal["conversion"]
    conversion: str
    stage: str
    value: float
    currency: str
    deliveries: list[Delivery]
    notLead: NotLeadReason


_FromValue = TypedDict("_FromValue", {"from": float})


class JourneyValue(_AtSubject, _FromValue):
    kind: Literal["value"]
    conversion: str
    to: float
    why: Literal["correct", "refund", "write_off", "reverse", "payment"]


class JourneyConsent(_AtSubject):
    kind: Literal["consent"]
    consent: Consent
    source: Optional[str]


class JourneyDecision(_AtSubject):
    kind: Literal["decision"]
    decision: int
    action: str
    by: Optional[str]
    reason: Optional[str]


JourneyEntry = Union[JourneyVisit, JourneySighting, JourneyCall, JourneyText, JourneyLink, JourneyConversion, JourneyValue, JourneyConsent, JourneyDecision]


class JourneyPage(TypedDict):
    subjects: dict[str, Tie]
    entries: list[JourneyEntry]
    next: Optional[int]
    more: int


class FindValue(TypedDict):
    by: Literal["email", "phone", "click", "subject", "name"]
    subjects: list[str]


class _MatchOptions(TypedDict, total=False):
    conflict: Literal["birth", "given"]
    unconfirmed: Literal[True]


class Match(_MatchOptions):
    subject: str
    members: list[str]
    score: float
    level: Level
    kinds: list[str]


class MatchValue(TypedDict):
    candidates: list[Match]
    notes: dict[str, str]


class Waiting(TypedDict):
    calls: int
    texts: int


class CallerValue(TypedDict):
    subject: Optional[str]
    area: Optional[str]
    known: bool
    people: list[Match]
    visitor: Optional[str]
    waiting: Waiting
    arrival: Optional[Arrival]


class Conflict(TypedDict):
    a: str
    b: str
    how: Literal["recorded", "same", "possible"]
    rests: list[str]


class ConflictsValue(TypedDict):
    conflicts: list[Conflict]


class _AmountAtOptions(TypedDict, total=False):
    kind: Literal["refund", "write_off"]


class AmountAt(_AmountAtOptions):
    value: float
    currency: str
    at: At


class ConversionView(_AtSubject):
    type: Literal["conversion"]
    stage: str
    values: list[AmountAt]
    notLead: NotLeadReason
    deliveries: list[Delivery]


class _CallViewOptions(TypedDict, total=False):
    partyHistory: list[Union[KnownPartyRecord, UnknownPartyRecord]]


class CallView(_CallView, _CallViewOptions):
    type: Literal["call"]


class TextView(_TextView):
    type: Literal["text"]
    flags: list[str]


RecordView = Union[ConversionView, CallView, TextView]


class Tied(TypedDict):
    subject: str
    asset: str
    relation: Relation
    score: float
    kinds: list[str]
    sent: int
    received: int
    count: int
    imbalance: float
    first: At
    last: At


class Ring(TypedDict):
    subjects: list[str]
    asset: str
    amount: int
    tied: int


class TransfersValue(TypedDict):
    counterparties: list[Tied]
    rings: list[Ring]


LookupValue = Union[PersonValue, JourneyPage, FindValue, MatchValue, CallerValue, PartyValue, ConflictsValue, RecordView, TransfersValue, None]


# Each report kind determines the value inside its asOf envelope.
Window = TypedDict("Window", {"from": str, "to": str, "timeZone": str})


class _CampaignsRequestOptions(TypedDict, total=False):
    by: str
    per: str


class CampaignsRequest(_CampaignsRequestOptions):
    kind: Literal["campaigns"]
    window: Window


class PipelineRequest(TypedDict):
    kind: Literal["pipeline"]
    at: At
    days: int


class _TimedReport(TypedDict):
    window: Window
    at: At


class CallsRequest(_TimedReport):
    kind: Literal["calls"]


class _After(TypedDict, total=False):
    after: str


class CallbacksRequest(_TimedReport, _After):
    kind: Literal["callbacks"]


class TextsRequest(_TimedReport, _After):
    kind: Literal["texts"]


PagedReportRequest = Union[CallbacksRequest, TextsRequest]


class AfterCallsRequest(_TimedReport):
    kind: Literal["after_calls"]
    step: str
    days: int


class DeliveriesRequest(TypedDict):
    kind: Literal["deliveries"]
    state: DeliveryState


ReportRequest = Union[CampaignsRequest, PipelineRequest, CallsRequest, PagedReportRequest, AfterCallsRequest, DeliveriesRequest]


class Delay(TypedDict):
    count: int
    median: float
    p95: float
    inside: float


class _StageCountOptions(TypedDict, total=False):
    delay: Delay


class StageCount(_StageCountOptions):
    count: int
    value: float
    people: int


class ValueChange(TypedDict):
    outcomes: int
    first: float
    firstUnknown: int
    now: float
    refunded: float
    writtenOff: float
    zeroed: int


class MonthChange(ValueChange):
    month: str


class Reported(TypedDict):
    days: int
    conversions: float
    value: Optional[float]
    credited: int
    creditedValue: float


class BreakdownRow(TypedDict):
    name: str
    stages: dict[str, StageCount]
    outcomes: int
    value: float
    people: int
    missed: int
    notLeads: int


class _ReportTotalOptions(TypedDict, total=False):
    reported: Reported
    breakdown: list[BreakdownRow]


class ReportTotal(_ReportTotalOptions):
    cost: float
    clicks: int
    impressions: int
    visits: int
    missed: int
    notLeads: int
    stages: dict[str, StageCount]
    outcomes: int
    value: float
    people: int
    valueChange: ValueChange
    costDays: int
    missingDays: int
    insufficientData: bool
    costPerOutcome: Optional[float]
    returnOnCost: Optional[float]


class ReportRow(ReportTotal):
    source: str
    campaignId: str
    campaign: str


class Incomplete(TypedDict):
    after: str
    days: int


class _CampaignsValueOptions(TypedDict, total=False):
    incomplete: Incomplete
    by: str
    per: str


class CampaignsValue(_From, _CampaignsValueOptions):
    to: str
    rows: list[ReportRow]
    total: ReportTotal
    days: int
    months: list[MonthChange]
    excluded: int
    dimensions: list[str]
    currencies: list[str]
    timeZone: str
    steps: list[str]


class PipelineCall(TypedDict):
    state: CallState
    direction: Direction


class _PipelineRowOptions(TypedDict, total=False):
    campaignCredit: CampaignCredit


class PipelineRow(_PipelineRowOptions):
    subject: str
    at: At
    late: bool
    step: Optional[str]
    value: Optional[float]
    currency: Optional[str]
    language: Optional[str]
    call: Optional[PipelineCall]
    arrival: Optional[Arrival]


class PipelineColumn(TypedDict):
    step: Optional[str]
    wait: Optional[float]
    people: int
    fresh: int
    late: Optional[int]
    done: Optional[int]
    rows: list[PipelineRow]


class PipelineValue(_From):
    at: At
    day: str
    unplaced: int
    columns: list[PipelineColumn]


class CallCounts(TypedDict):
    answered: int
    missed: int
    voicemail: int
    waiting: int
    unknown: int
    calls: int
    returned: int
    reported: int
    calledAgain: int
    notLeads: int
    hidden: int


class CallCell(CallCounts):
    weekday: int
    hour: int


class Coverage(TypedDict):
    visitor: int
    channel: int
    neither: int
    noResult: int


class CallSummary(TypedDict):
    total: CallCounts
    closed: Optional[CallCounts]
    cells: list[CallCell]
    coverage: Coverage
    returnedWithin: Optional[int]


class _CallbackRowOptions(TypedDict, total=False):
    campaignCredit: CampaignCredit


class CallbackRow(_CallbackRowOptions):
    call: str
    subject: str
    at: At
    state: CallState
    attempts: int
    arrival: Optional[Arrival]


class TextRow(TypedDict):
    text: str
    subject: str
    at: At
    unanswered: int
    arrival: Optional[Arrival]


class CallbacksPage(TypedDict):
    rows: list[CallbackRow]
    next: Optional[str]


class TextsPage(TypedDict):
    rows: list[TextRow]
    next: Optional[str]


class FollowedRow(TypedDict):
    name: str
    people: int
    reached: int
    share: float


class FollowedGroup(TypedDict):
    by: Literal["talk", "answer", "language", "returned"]
    rows: list[FollowedRow]
    suppressed: int


class ExcludedFirst(TypedDict):
    already: int
    running: int


class ExcludedReturned(ExcludedFirst):
    through: int


class FollowedExcluded(TypedDict):
    first: ExcludedFirst
    returned: ExcludedReturned


class Followed(TypedDict):
    step: str
    days: int
    least: int
    groups: list[FollowedGroup]
    excluded: FollowedExcluded


class DeliveriesValue(TypedDict):
    deliveries: list[Delivery]


class CampaignsResponse(TypedDict):
    asOf: At
    value: CampaignsValue


class PipelineResponse(TypedDict):
    asOf: At
    value: PipelineValue


class CallsResponse(TypedDict):
    asOf: At
    value: CallSummary


class CallbacksResponse(TypedDict):
    asOf: At
    value: CallbacksPage


class TextsResponse(TypedDict):
    asOf: At
    value: TextsPage


class AfterCallsResponse(TypedDict):
    asOf: At
    value: Followed


class DeliveriesResponse(TypedDict):
    asOf: At
    value: DeliveriesValue


PagedReportResponse = Union[CallbacksResponse, TextsResponse]
ReportResponse = Union[CampaignsResponse, PipelineResponse, CallsResponse, CallbacksResponse, TextsResponse, AfterCallsResponse, DeliveriesResponse]


# Unknown event types keep their sequence so the caller can still checkpoint the page.
class EventsRequest(TypedDict):
    after: Optional[str]
    limit: int


class _Event(TypedDict):
    schemaVersion: Literal[1]
    seq: int
    at: At


ClusterChangedData = TypedDict("ClusterChangedData", {"subject": str, "from": Optional[str], "to": Optional[str]})


class ClusterChanged(_Event):
    type: Literal["cluster.changed"]
    data: ClusterChangedData


class ConversionFailedData(TypedDict):
    conversion: str
    platform: str
    note: str


class ConversionFailed(_Event):
    type: Literal["conversion.failed"]
    data: ConversionFailedData


class DeliveryPausedData(TypedDict):
    reason: str


class DeliveryPaused(_Event):
    type: Literal["delivery.paused"]
    data: DeliveryPausedData


class DeliveryLateData(TypedDict):
    oldestDue: At


class DeliveryLate(_Event):
    type: Literal["delivery.late"]
    data: DeliveryLateData


class CostsFailedData(TypedDict):
    source: str
    reason: str


class CostsFailed(_Event):
    type: Literal["costs.failed"]
    data: CostsFailedData


class FeedQuietData(TypedDict):
    feed: Literal["touches", "calls", "results", "costs"]
    last: Optional[At]
    hours: float


class FeedQuiet(_Event):
    type: Literal["feed.quiet"]
    data: FeedQuietData


class CallbackOverdueData(TypedDict):
    call: str
    subject: str
    missedAt: At
    attempts: int
    source: str
    campaign: Optional[str]
    campaignId: Optional[str]


class CallbackOverdue(_Event):
    type: Literal["callback.overdue"]
    data: CallbackOverdueData


class AuditHeadData(TypedDict):
    seq: int
    hash: str
    sound: bool
    brokenAt: Optional[int]


class AuditHead(_Event):
    type: Literal["audit.head"]
    data: AuditHeadData


GraphEvent = Union[ClusterChanged, ConversionFailed, DeliveryPaused, DeliveryLate, CostsFailed, FeedQuiet, CallbackOverdue, AuditHead]


class UnrecognizedEvent(TypedDict):
    schemaVersion: Literal[1]
    seq: int
    type: Literal["Unrecognized"]
    raw: object


class EventPage(TypedDict):
    schemaVersion: Literal[1]
    events: list[Union[GraphEvent, UnrecognizedEvent]]
    cursor: str
    more: bool


class EventsAccepted(TypedDict):
    ok: Literal[True]
    value: EventPage


class CursorLost(TypedDict):
    ok: Literal[False]
    reason: Literal["CURSOR_LOST"]


EventsResponse = Union[EventsAccepted, CursorLost]
