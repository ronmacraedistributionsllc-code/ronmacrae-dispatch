import type {
  AddressChangeStatus,
  CodDisputeType,
  CodStatus,
  ConversationKind,
  CustomerIdentityStatus,
  FailureReason,
  JobSource,
  JobStatus,
  JobType,
  MessageSenderRole,
  NotificationChannel,
  NotificationStatus,
  PayoutMethod,
  PayoutStatus,
  PaymentMethod,
  PaymentStatus,
  PlatformMessageKind,
  PlatformMessageSenderRole,
  Priority,
  ProofKind,
  ReconStatus,
  RiderStage,
  RiderStatus,
  Role,
  SettlementType,
  SosStatus,
  TrackingState,
  VehicleType,
} from "./enums.js";
import type { Money } from "@ronmacrae/money";

/** All timestamps are ISO-8601 UTC strings in API contracts. */

export interface GeoPoint {
  lat: number;
  lng: number;
  /** horizontal accuracy in meters, when the client reports it */
  accuracyM?: number;
}

/** Minimal GeoJSON geometry types (avoids a @types/geojson dependency). */
export type GeoPosition = [number, number];
export interface GeoJsonPolygon {
  type: "Polygon";
  coordinates: GeoPosition[][];
}
export interface GeoJsonMultiPolygon {
  type: "MultiPolygon";
  coordinates: GeoPosition[][][];
}
export type ZoneGeometry = GeoJsonPolygon | GeoJsonMultiPolygon;

export interface UserDto {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  active: boolean;
  totpEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  /** Platform-wide authority (owner.ts, platform-admin.ts) — independent
   *  of, and not implied by, `role`. Absent/null for every ordinary
   *  staff/rider account. */
  platformRole: "owner" | null;
}

export interface RiderDto {
  id: string;
  name: string;
  phone: string;
  vehicle: VehicleType;
  plate: string | null;
  photoUrl: string | null;
  status: RiderStatus;
  homeZoneId: string | null;
  homeZoneName: string | null;
  basePoint: GeoPoint | null;
  dailyCapacity: number;
  payRatePerDelivery: Money | null;
  active: boolean;
  currentJobId: string | null;
  createdAt: string;
}

/** One rider row on the dispatcher operations board (spec 5C) — everything a
 *  dispatcher needs to judge a rider's current load and reachability without
 *  opening several screens. Respects the same staff-only access as the
 *  underlying rider/location endpoints it's assembled from. */
export interface OpsBoardRiderDto {
  id: string;
  name: string;
  phone: string;
  status: RiderStatus;
  /** the rider's own "Available for jobs" toggle state */
  availableForJobs: boolean;
  activeJobCount: number;
  capacity: number;
  capacityRemaining: number;
  /** true only while this rider's own websocket is currently connected to the hub */
  connected: boolean;
  location: {
    point: GeoPoint;
    trackingState: TrackingState;
    at: string;
    ageMs: number;
    /** honest staleness signal — never treat a stale point as the rider's
     *  current position; this is exactly the flag that says so. */
    stale: boolean;
  } | null;
}

export interface OpsBoardOfferDto {
  id: string;
  jobId: string;
  jobNumber: string | null;
  riderId: string;
  riderName: string;
  urgent: boolean;
  expiresAt: string;
  createdAt: string;
}

/** A job flagged as overdue on the board — its own promised/scheduled time
 *  has already passed while it's still in an active (non-terminal) status. */
export interface OpsBoardOverdueJobDto {
  id: string;
  jobNumber: string | null;
  status: JobStatus;
  priority: Priority;
  riderName: string | null;
  dueAt: string;
  overdueByMs: number;
}

export interface OpsBoardDto {
  riders: OpsBoardRiderDto[];
  waitingOffers: OpsBoardOfferDto[];
  urgentJobs: JobSummaryDto[];
  overdueJobs: OpsBoardOverdueJobDto[];
  codAwaitingHandover: JobSummaryDto[];
  generatedAt: string;
}

/** Filters actually applied to an operating report — echoed back so the UI
 *  (and anyone reading the CSV later) can see exactly what's included. */
export interface OperatingReportFilters {
  from: string | null;
  to: string | null;
  riderId: string | null;
  zoneId: string | null;
  /** one of the three report buckets, or omitted for all */
  bucket: "completed" | "active" | "failed_cancelled" | null;
  paymentMethod: string | null;
  /** Stage 39: restricts to jobs completed by a rider attached to this one
   *  logistics company — see OperatingReportLogisticsRowDto's own doc
   *  comment for how a job maps to a company (via its rider, not directly). */
  logisticsCompanyId: string | null;
}

/** One job row in the report — deliberately excludes the delivery PIN and
 *  the customer's phone number (spec 5E: "without exposing delivery PINs or
 *  unnecessary customer information"); customer *name* is kept since it's
 *  needed to reconcile a specific delivery, phone is not. */
export interface OperatingReportRowDto {
  jobId: string;
  jobNumber: string | null;
  createdAt: string;
  completedAt: string | null;
  status: JobStatus;
  bucket: "completed" | "active" | "failed_cancelled";
  urgent: boolean;
  zoneName: string | null;
  riderId: string | null;
  riderName: string | null;
  customerName: string;
  paymentMethod: string;
  deliveryFee: Money | null;
  amountExpected: Money | null;
  amountCollected: Money | null;
  codHandedInAmount: Money | null;
  /** completedAt - createdAt, ms — only ever computed from real recorded
   *  timestamps, never a scheduled/promised target; null until delivered. */
  deliveryTimeMs: number | null;
}

export interface OperatingReportRiderRowDto {
  riderId: string;
  riderName: string;
  jobsCompleted: number;
  /** payRate x jobsCompleted — an estimate from the rider's configured rate,
   *  not a record of an actual payout (no payout run has happened); null,
   *  never 0, when the rider has no rate configured, so a real "$0 earned"
   *  can never be confused with "we don't know". */
  estimatedEarnings: Money | null;
}

/** One logistics company's completed-delivery share of the report (spec:
 *  "reports broken out by logistics company") — a job has no direct link
 *  to a logistics company; this groups by whichever company the *rider who
 *  completed it* was attached to at query time (Rider.attachedLogisticsCompanyId),
 *  same indirection `byRider` already uses for pay rate. A rider who was
 *  freelance or merchant-attached when they completed jobs contributes to
 *  neither this table nor any company's total — see `unattachedJobsCompleted`
 *  on the summary for that honest remainder. */
export interface OperatingReportLogisticsRowDto {
  logisticsCompanyId: string;
  logisticsCompanyName: string;
  jobsCompleted: number;
  /** distinct riders (attached to this company) who contributed at least one completed job */
  riderCount: number;
}

export interface OperatingReportSummaryDto {
  deliveriesCompleted: number;
  deliveriesActive: number;
  deliveriesFailedCancelled: number;
  urgentDeliveryCount: number;
  deliveryFeesCharged: Money;
  codExpected: Money;
  codCollected: Money;
  codHandedIn: Money;
  /** expected - collected, summed only over jobs still short something */
  codOutstanding: Money;
  codShortageTotal: Money;
  codOverageTotal: Money;
  /** average of completed jobs' deliveryTimeMs; null if none completed in range */
  averageDeliveryTimeMs: number | null;
  /** how many completed jobs the average above is actually based on — shown
   *  so a tiny sample doesn't get read as a stable average */
  averageDeliveryTimeSampleSize: number;
  /** Completed jobs whose rider was freelance or merchant-attached (not a
   *  logistics company) at query time — the honest remainder so
   *  `byLogisticsCompany`'s totals are never mistaken for the full
   *  `deliveriesCompleted` count. */
  unattachedJobsCompleted: number;
}

export interface OperatingReportDto {
  filters: OperatingReportFilters;
  summary: OperatingReportSummaryDto;
  byRider: OperatingReportRiderRowDto[];
  byLogisticsCompany: OperatingReportLogisticsRowDto[];
  rows: OperatingReportRowDto[];
  /** plain-language call-outs for anything that makes a figure above
   *  incomplete or approximate (e.g. riders with no configured pay rate) —
   *  never silently swept under a total. */
  notes: string[];
  generatedAt: string;
}

export interface CustomerDto {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  addressText: string | null;
  landmark: string | null;
  point: GeoPoint | null;
  zoneId: string | null;
  zoneName: string | null;
  preferredChannel: NotificationChannel | null;
  consentTracking: boolean;
  consentMarketing: boolean;
  note: string | null;
  createdAt: string;
}

/** One address-search suggestion. `provider: "simulated"` means real address search
 *  is unavailable right now (no network / no map provider reachable) — the point is
 *  a deterministic offline approximation, not a real match, and callers should say
 *  so rather than presenting it as a normal result. */
export interface GeoSuggestionDto {
  point: GeoPoint;
  label: string;
  confidence: "high" | "medium" | "low";
  provider: string;
}

export interface ZoneDto {
  id: string;
  name: string;
  slug: string;
  parish: string | null;
  /** GeoJSON Polygon or MultiPolygon */
  geometry: ZoneGeometry;
  baseFee: Money;
  perKmFee: Money | null;
  /** Flat surcharge added when a job in this zone is marked urgent, if the zone has one set. */
  urgentSurchargeFee: Money | null;
  active: boolean;
  version: number;
}

export interface FareRuleDto {
  id: string;
  fromZoneId: string;
  fromZoneName: string;
  toZoneId: string;
  toZoneName: string;
  fee: Money;
  minFee: Money | null;
  note: string | null;
  validFrom: string;
}

export interface FareQuoteRequest {
  fromPoint: GeoPoint;
  toPoint: GeoPoint;
  fromZoneId?: string | null;
  toZoneId?: string | null;
  express?: boolean;
  heavy?: boolean;
  weightKg?: number;
  /** Applies the destination zone's urgentSurchargeFee, if it has one set. */
  urgent?: boolean;
}

export interface FareQuoteDto {
  fare: Money;
  fee: Money;
  subtotal: Money;
  breakdown: { label: string; amount: Money }[];
  distanceM: number | null;
  durationS: number | null;
  routingProvider: string;
}

export interface JobEventDto {
  id: string;
  jobId: string;
  from: JobStatus | null;
  to: JobStatus;
  actorType: "rider" | "dispatcher" | "system" | "customer" | "webhook";
  actorId: string | null;
  actorName: string | null;
  note: string | null;
  meta: Record<string, unknown> | null;
  at: string;
}

/** One append-only entry in a job's COD reconciliation audit trail. */
export interface CodEventDto {
  id: string;
  jobId: string;
  from: CodStatus | null;
  to: CodStatus;
  actorType: "rider" | "dispatcher" | "system" | "customer" | "webhook";
  actorId: string | null;
  actorName: string | null;
  note: string | null;
  meta: Record<string, unknown> | null;
  at: string;
}

export interface JobDto {
  id: string;
  /** human-unique job number (e.g. RM-000123) shown to staff and customers */
  jobNumber: string | null;
  /** where the order came from: manual / web / knutsford / zipmail / courier / woo */
  source: JobSource;
  externalRef: string | null;
  originalJobId: string | null;
  returnJobId: string | null;
  type: JobType;
  status: JobStatus;
  priority: Priority;
  /** Which store/merchant client this order is for — null for a direct/
   *  in-house order (no third-party merchant involved). */
  merchantId: string | null;
  merchantName: string | null;
  customerId: string;
  customerName: string;
  customerPhone: string;
  addressText: string | null;
  /** Geocoder's formatted match, if any — informational; addressText is authoritative. */
  addressProviderText: string | null;
  landmark: string | null;
  point: GeoPoint | null;
  zoneId: string | null;
  zoneName: string | null;
    pickupPoint: GeoPoint | null;
    pickupAddressText: string | null;
    pickupAddressProviderText: string | null;
    pickupContact: string | null;
    itemSummary: string | null;
    /** units of the product in this order (1 when not stated) — for a
     *  multi-item order this is the total quantity across all items, kept
     *  in sync for anything still reading it directly; `items` below is the
     *  real per-line detail. */
    quantity: number | null;
    /** product size / colour details (e.g. "Large", "Red") - kept separate for picking */
    itemSize: string | null;
    itemColor: string | null;
    packageSize: string | null;
    instructions: string | null;
    /** Real per-line order detail (spec: "AN ORDER MUST SUPPORT MORE THAN ONE
     *  ITEM"). Always has at least one entry for any job created through an
     *  item-aware path; empty for older jobs created before this existed —
     *  `itemSummary`/`quantity`/`itemSize`/`itemColor` above remain the
     *  fallback for those. */
    items: JobItemDto[];
    /** rider sub-progress (heading to pickup / at pickup / heading to dropoff) */
    stage: RiderStage;
    vehicle: VehicleType | null;
    /** product value of the order */
    fare: Money | null;
    /** delivery fee - always separate from the order value */
    fee: Money | null;
    subtotal: Money | null;
    paymentMethod: string;
    /** cash position: unpaid / partial / paid */
    paymentStatus: PaymentStatus;
    /** delivery PIN (only exposed to rider once en route, and to customer via link) */
    pin: string | null;
    amountExpected: Money | null;
    amountCollected: Money | null;
    /** Full COD reconciliation ledger — internal only (never sent on the public
     *  tracking DTO). See CodEventDto for the append-only audit trail. */
    codStatus: CodStatus;
    codCollectedAt: string | null;
    codHandedInAmount: Money | null;
    codHandoverAt: string | null;
    /** handedIn - collected, in minor units of the job's currency; positive =
     *  overage (handed in more than collected), negative = shortage. Null until
     *  a handover has been recorded (nothing to compare yet). */
    codVarianceMinor: number | null;
    codRiderNote: string | null;
    codAccountantNote: string | null;
    codApprovedById: string | null;
    codApprovedByName: string | null;
    codApprovedAt: string | null;
    /** Set when a dispute is raised, kept after resolution as the record of
     *  what kind it was — see CodDisputeType's own doc comment. */
    codDisputeType: CodDisputeType | null;
    /** Housekeeping-only: hides a settled entry from the day-to-day COD
     *  board once archived — never a delete, always reversible, and never
     *  filtered out of reports/audit/the summary endpoint. */
    codArchivedAt: string | null;
    codArchivedByName: string | null;
    failureReason: FailureReason | null;
    failureNote: string | null;
  scheduledAt: string | null;
  promisedAt: string | null;
  completedAt: string | null;
  riderId: string | null;
  riderName: string | null;
    routeSeq: number | null;
    routeEta: string | null;
    /** customer tracking link (dispatcher copies/shares it); null until created */
    link: TrackingLinkDto | null;
    /** proof files attached to this job */
    proofs: ProofDto[];
    createdAt: string;
    updatedAt: string;
  }

export interface JobSummaryDto {
  id: string;
  jobNumber: string | null;
  externalRef: string | null;
  source: JobSource;
  type: JobType;
  status: JobStatus;
  priority: Priority;
  merchantId: string | null;
  merchantName: string | null;
  customerName: string;
  customerPhone: string;
  addressText: string | null;
  point: GeoPoint | null;
  pickupAddressText: string | null;
  pickupPoint: GeoPoint | null;
  zoneName: string | null;
  itemSummary: string | null;
  quantity: number | null;
  itemSize: string | null;
  itemColor: string | null;
  paymentMethod: string;
  paymentStatus: PaymentStatus;
  amountExpected: Money | null;
  amountCollected: Money | null;
  codStatus: CodStatus;
  codHandedInAmount: Money | null;
  codDisputeType: CodDisputeType | null;
  codArchivedAt: string | null;
  riderId: string | null;
  riderName: string | null;
  stage: RiderStage;
  routeSeq: number | null;
  scheduledAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Business-wide COD reconciliation rollup (spec: "financial dispute/
 *  archival workflow") — turns the per-job variance already shown on each
 *  COD row into an accountable total. Never filtered by archived status —
 *  same "reports never filter this out" rule as everywhere else archived/
 *  deleted financial history is handled in this app. */
export interface CodSummaryDto {
  shortage: Money;
  shortageCount: number;
  overage: Money;
  overageCount: number;
  matchedCount: number;
  /** A dispute raised before any hand-in was recorded — there's no
   *  handed-in amount yet to compute a variance from, so these are
   *  counted separately rather than silently folded into "matched". */
  disputedBeforeHandoverCount: number;
}

/** One entry in the deleted-orders trash (spec 8, Stage 26) — a soft-
 *  deleted job, restorable for 30 days from `deletedAt`. Nothing about the
 *  underlying job (or its ledger/dispute/audit records) was ever actually
 *  removed; `purged` just means the restore window has passed. */
export interface TrashedJobDto extends JobSummaryDto {
  deletedAt: string;
  deletedByName: string | null;
  deleteReason: string | null;
  purged: boolean;
  daysRemaining: number;
}

/** One rider cash-profile bucket (spec 9, Stage 27) — a count plus the
 *  exact sum, never an estimate. */
export interface CashBucketDto {
  count: number;
  amount: Money;
}

/** One business's slice of a rider's cash profile — never combined across
 *  businesses (see cash-profile.ts's own doc comment for why). `confirmed`
 *  is derived fresh from every job whose COD is accountant-approved, at
 *  read time — a hand-in recorded on a different job can never touch it,
 *  which is the actual fix for "Handed in must not auto-clear
 *  confirmed-owed amount." */
export interface RiderCashBusinessProfileDto {
  businessId: string;
  businessName: string;
  /** Collected from customers, not yet handed to the office. */
  collected: CashBucketDto;
  /** Rider says it's handed in; not yet accountant-confirmed. */
  handedInUnconfirmed: CashBucketDto;
  /** Accountant-confirmed and reconciled — settled. */
  confirmed: CashBucketDto;
  /** Under active dispute. */
  disputed: CashBucketDto;
  /** What was actually handed in minus what was recorded collected,
   *  across every job that reached at least a hand-in — a real shortage
   *  (negative) or overage (positive), never silently absorbed into
   *  either bucket's own total. */
  handoverVariance: Money;
  /** What this business owes the rider for their own completed work —
   *  kept structurally separate from the COD buckets above, which are
   *  cash the rider owes *to* the business. Null if no pay rate is
   *  configured (shown as "not set", never $0). */
  earningsPayable: Money | null;
  earningsNote: string | null;
  /** The same four buckets, split by which merchant's cash it is — a rider
   *  can carry COD for several of this business's merchants at once, and
   *  "the rider has $57,000" is meaningless without saying whose it is
   *  (spec: rider cash by merchant). One entry has `merchantId: null` for
   *  this business's own direct/in-house orders (no third-party merchant),
   *  when there are any. Every bucket here sums to the matching bucket
   *  above — this is a breakdown of the same totals, not a separate figure. */
  byMerchant: RiderCashMerchantProfileDto[];
}

/** One merchant's slice of a rider's cash-for-this-business profile. */
export interface RiderCashMerchantProfileDto {
  merchantId: string | null;
  /** "Direct orders" when `merchantId` is null. */
  merchantName: string;
  collected: CashBucketDto;
  handedInUnconfirmed: CashBucketDto;
  confirmed: CashBucketDto;
  disputed: CashBucketDto;
  handoverVariance: Money;
}

/** GET /api/bearer/cash (rider's own, every active membership) or
 *  GET /api/riders/:id/cash (staff, that business's slice only). */
export interface RiderCashProfileDto {
  riderId: string;
  riderName: string;
  businesses: RiderCashBusinessProfileDto[];
}

export interface JobOfferDto {
  id: string;
  jobId: string;
  status: "open" | "accepted" | "declined" | "withdrawn" | "expired";
  expiresAt: string;
  pickupArea: string | null;
  destinationArea: string | null;
  merchantName: string | null;
  itemSummary: string | null;
  deliveryFee: Money | null;
  riderEarnings: Money | null;
  codAmount: Money | null;
  requestedAt: string | null;
  createdAt: string;
  urgent: boolean;
  /** Staff-facing only (dispatcher offers list) — omitted on rider-facing routes. */
  riderId?: string;
  riderName?: string;
}

export interface AssignmentDto {
  id: string;
  jobId: string;
  riderId: string;
  riderName: string;
  status: "assigned" | "accepted" | "declined" | "reassigned";
  reason: string | null;
  oldRiderId: string | null;
  at: string;
}

export interface RouteStopDto {
  id: string;
  routeId: string;
  jobId: string;
  seq: number;
  point: GeoPoint;
  customerName: string | null;
  addressText: string | null;
  etaAt: string | null;
}

export interface RouteDto {
  id: string;
  riderId: string;
  riderName: string;
  date: string;
  status: "planned" | "active" | "abandoned" | "completed";
  totalDistanceM: number | null;
  totalDurationS: number | null;
  stops: RouteStopDto[];
  createdAt: string;
}

export interface RiderLocationDto {
  id: string;
  riderId: string;
  point: GeoPoint;
  heading: number | null;
  speedKph: number | null;
  batteryPct: number | null;
  trackingState: TrackingState;
  at: string;
}

export interface ProofDto {
  id: string;
  jobId: string;
  kind: ProofKind;
  url: string;
  sizeBytes: number;
  point: GeoPoint | null;
  at: string;
}

export interface TrackingLinkDto {
  id: string;
  jobId: string;
  token: string;
  url: string;
  expiresAt: string;
  revoked: boolean;
  lastAccessAt: string | null;
  createdAt: string;
}

/** Public payload for GET /api/tracking/:token - no auth required. */
export interface TrackingPublicDto {
  token: string;
  expired: boolean;
  job: {
    id: string;
    jobNumber: string | null;
    status: string;
    customerStatus: string;
    customerName: string;
    addressText: string | null;
    landmark: string | null;
    itemSummary: string | null;
    scheduledAt: string | null;
    promisedAt: string | null;
    completedAt: string | null;
    failureReason: string | null;
    /** PIN is revealed to the customer only while the rider is en route */
    pin: string | null;
    amountExpected: Money | null;
    paymentMethod: string;
  };
  rider: {
    name: string;
    photoUrl: string | null;
    vehicle: VehicleType | null;
    plate: string | null;
    phone: string | null;
  } | null;
  location: {
    point: GeoPoint | null;
    trackingState: TrackingState;
    etaAt: string | null;
    updatedAt: string | null;
  };
  statusHistory: { status: string; at: string }[];
  generatedAt: string;
}

/** One order on the cross-business customer package dashboard (spec 4) — a
 *  summary card, not the full single-job tracking page (that stays a
 *  click-through via `trackingUrl`, when one already exists). */
export interface CustomerPackageDto {
  jobId: string;
  businessName: string;
  jobNumber: string | null;
  itemSummary: string | null;
  customerStatus: string;
  scheduledAt: string | null;
  promisedAt: string | null;
  completedAt: string | null;
  amountExpected: Money | null;
  paymentMethod: string;
  /** Same restriction as TrackingPublicDto.job.pin: only while en route. */
  pin: string | null;
  riderName: string | null;
  /** Restricted the same way as the single-job tracking page (see
   *  tracking.ts's LOCATION_VISIBLE_STATUSES) — null whenever the job isn't
   *  actively out with the rider right now, regardless of whether a rider
   *  is assigned or has ever reported a position. */
  location: { point: GeoPoint | null; trackingState: TrackingState; etaAt: string | null; updatedAt: string | null } | null;
  /** Only set when an active (non-revoked, non-expired) tracking link
   *  already exists for this job — this endpoint never creates one, since
   *  that's a staff-only action elsewhere. */
  trackingUrl: string | null;
}

/** GET /api/customer-dashboard — everything this phone number has ordered
 *  across every business on the platform. `active`/`history` split mirrors
 *  the rider dashboard's own in-progress/completed convention. */
export interface CustomerPackagesDto {
  active: CustomerPackageDto[];
  history: CustomerPackageDto[];
  generatedAt: string;
}

/** A group of CustomerIdentity rows that plausibly belong to the same real
 *  person (share a normalized email) but haven't been merged — GET
 *  /api/owner/customer-identities/duplicates, owner-only (Stage 23, spec
 *  section 6). Surfaced for a human to confirm or reject, never acted on
 *  automatically. */
export interface DuplicateCandidateDto {
  normalizedEmail: string;
  identities: {
    id: string;
    normalizedPhone: string;
    status: CustomerIdentityStatus;
    customerCount: number;
    businessNames: string[];
  }[];
}

/** Whether the phone-verified session behind this request already has an
 *  optional email+password account (Stage 25, spec 7), and its
 *  verification state. `GET /api/customer-account/status`. */
export interface CustomerAccountStatusDto {
  hasAccount: boolean;
  email: string | null;
  emailVerified: boolean;
}

/** One delivery-chat message, scoped to one of the three real pairwise
 *  conversations (Stage 24, spec 5) — `conversationKind: null` means a
 *  "legacy" message from before this stage's redesign, when every party
 *  shared one merged thread; kept as a read-only archive, never guessed
 *  into one of the three new conversations (see ConversationKind's own
 *  doc comment). Never carries a phone number or the delivery PIN —
 *  `senderName` is a role-appropriate label ("You"/"Dispatch"/"Rider"/
 *  "Customer"), not a phone number, and is the only identifying detail
 *  ever included. */
export interface DeliveryMessageDto {
  id: string;
  jobId: string;
  conversationKind: ConversationKind | null;
  senderRole: MessageSenderRole;
  /** true only for the message the current viewer themselves sent */
  isSelf: boolean;
  senderName: string;
  body: string;
  /** Set once the message reached the *other* side of this conversation —
   *  live immediately if they had a connected realtime socket at send
   *  time (rider/staff), otherwise (customers are poll-only — this app
   *  has no live push channel to them) on their next fetch, same trigger
   *  as `read`. Meaningless (always false) on a message you sent
   *  yourself — this is the recipient's receipt, not a sent-confirmation. */
  delivered: boolean;
  /** Set when the recipient's client actually loaded this conversation.
   *  Same honest caveat as `delivered` for poll-only recipients. */
  read: boolean;
  createdAt: string;
}

export interface DeliveryMessagesDto {
  jobId: string;
  /** the delivery's own lifecycle status, so a closed conversation can show
   *  why (delivered/cancelled/etc.) rather than just going silent */
  jobStatus: JobStatus;
  /** false once the job is terminal or (customer view only) the tracking
   *  link has expired/been revoked — no new messages can be posted, but the
   *  full history stays visible for anyone still authorized to see it. */
  open: boolean;
  /** Which single conversation this list is — null only for the one
   *  legacy-archive endpoint (pre-Stage-24 messages, read-only). */
  conversationKind: ConversationKind | null;
  messages: DeliveryMessageDto[];
}

/** Unread-count + preview summary across every conversation a viewer can
 *  see for one job — powers a tab/badge UI without fetching every
 *  conversation's full message list (Stage 24). */
export interface ConversationSummaryDto {
  kind: ConversationKind;
  /** false only for customer_rider on the staff side — staff may monitor
   *  it (see ConversationsDto) but never post into a conversation they
   *  aren't a party to. */
  canWrite: boolean;
  unreadCount: number;
  lastMessage: { body: string; senderRole: MessageSenderRole; createdAt: string } | null;
}

export interface ConversationsDto {
  jobId: string;
  conversations: ConversationSummaryDto[];
}

/** Non-job-scoped direct message (spec: "secure messaging with a strict
 *  authorization matrix... admin-to-anyone, logistics<->riders") — see
 *  schema.prisma's PlatformMessage doc comment for the two thread shapes
 *  this appears in. Same "You"/role-label convention as DeliveryMessageDto,
 *  and the same honest read-receipt caveat (no live channel to every side). */
export interface PlatformMessageDto {
  id: string;
  senderRole: PlatformMessageSenderRole;
  isSelf: boolean;
  senderName: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export interface PlatformMessagesDto {
  kind: PlatformMessageKind;
  messages: PlatformMessageDto[];
}

/** One row in Platform Admin's own inbox — every user who has an
 *  `owner_user` thread, most-recently-active first. */
export interface PlatformMessageThreadDto {
  userId: string;
  userName: string;
  unreadCount: number;
  lastMessage: { body: string; senderRole: PlatformMessageSenderRole; createdAt: string } | null;
}

/** A customer/rider's proposed new destination, awaiting dispatch review —
 *  never applied to the job until explicitly approved (spec 5G). */
export interface AddressChangeRequestDto {
  id: string;
  jobId: string;
  requestedByRole: MessageSenderRole;
  proposedAddressText: string;
  note: string | null;
  status: AddressChangeStatus;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

/**
 * Public delivery request (the customer's "book a delivery" form).
 * Upserts the customer by phone, creates a `web`-source job, and returns
 * a unique job number plus the customer tracking link.
 */
export interface DeliveryRequestInput {
  name: string;
  phone: string;
  email?: string | null;
  /** where the courier picks the package up (the store, unless stated) */
  pickupAddressText?: string | null;
  /** delivery destination */
  addressText?: string | null;
  landmark?: string | null;
  itemSummary?: string | null;
  itemSize?: string | null;
  itemColor?: string | null;
  quantity?: number;
  /** product value (major units) */
  fare?: number | null;
  /** delivery fee (major units); usually set by the store, not the customer */
  fee?: number | null;
  paymentMethod?: "cod" | "online";
  /** ISO datetime for the requested delivery time */
  scheduledAt?: string | null;
  instructions?: string | null;
  consentTracking?: boolean;
}

export interface DeliveryRequestResultDto {
  jobId: string;
  jobNumber: string | null;
  customerName: string;
  tracking: TrackingLinkDto | null;
}

export interface OutboxMessageDto {
  id: string;
  channel: NotificationChannel;
  to: string;
  template: string;
  params: Record<string, string>;
  jobId: string | null;
  status: NotificationStatus;
  provider: string;
  providerRef: string | null;
  error: string | null;
  attempts: number;
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

/** One configurable customer-message template (spec 5D) — `body` is the
 *  effective text (an override if one is set, else the built-in default);
 *  `defaultBody` is always the built-in one, shown so an admin editing an
 *  override can see what they're diverging from. */
export interface NotificationTemplateDto {
  name: string;
  body: string;
  defaultBody: string;
  overridden: boolean;
}

export interface ReconDailyDto {
  id: string;
  riderId: string;
  riderName: string;
  /** YYYY-MM-DD */
  date: string;
  expectedCod: Money;
  collectedCod: Money;
  declared: Money | null;
  variance: Money;
  status: ReconStatus;
  note: string | null;
  resolvedAt: string | null;
}

export interface PayoutDto {
  id: string;
  riderId: string;
  riderName: string;
  periodStart: string;
  periodEnd: string;
  base: Money;
  perDelivery: Money;
  codCollected: Money;
  deductions: Money;
  net: Money;
  method: PayoutMethod | null;
  status: PayoutStatus;
  reference: string | null;
  note: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  lines: { jobId: string; description: string; amount: Money }[];
  createdAt: string;
}

export interface SosAlertDto {
  id: string;
  riderId: string;
  riderName: string;
  riderPhone: string | null;
  jobId: string | null;
  point: GeoPoint | null;
  note: string | null;
  status: SosStatus;
  at: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface AuditEntryDto {
  id: string;
  actorId: string | null;
  actorName: string | null;
  role: Role | null;
  action: string;
  entityType: string;
  entityId: string | null;
  ip: string | null;
  meta: Record<string, unknown> | null;
  at: string;
}

export interface SettingsDto {
  key: string;
  value: unknown;
  updatedAt: string;
}

/** Business settings blob stored under key `business` */
/** What a rider's "Contact dispatch" button (spec 5F) is allowed to see —
 *  deliberately narrower than the full BusinessSettings blob: only the
 *  owner-configured dispatch contact info, never any individual staff
 *  member's own phone number. */
export interface DispatchContactDto {
  businessName: string;
  dispatchPhone: string;
  dispatchWhatsApp: string;
}

export interface BusinessSettings {
  businessName: string;
  dispatchPhone: string;
  dispatchWhatsApp: string;
  /** Where the "a new order came in" email alert goes — every order,
   *  merchant-linked or not (see dispatch-notify.ts). Empty = no alert. */
  dispatchNotificationEmail: string;
  operationalCurrency: string;
  /** 1 USD -> X JMD, for dual currency display */
  usdToJmdRate: number | null;
  defaultZoneId: string | null;
  pinLength: number;
  trackingLinkTtlHours: number;
  /** true = bearer web location is best-effort; native app recommended */
  nativeAppRecommended: boolean;
}

// ---------- Merchants / catalog / multi-item orders ----------

/** One line of an order — the real per-item detail (spec: an order must
 *  support more than one item). `productId`/`productVariantId` are null for
 *  a free-text item (a merchant without a catalog, or the customer/staff
 *  typed something not in it); `unitPrice` is always a real snapshot taken
 *  at order time, never re-derived from the current product price later. */
export interface JobItemDto {
  id: string;
  productId: string | null;
  productVariantId: string | null;
  name: string;
  size: string | null;
  color: string | null;
  quantity: number;
  unitPrice: Money;
  /** unitPrice × quantity, for convenience — always derivable, never authoritative on its own. */
  lineTotal: Money;
  notes: string | null;
}

/** Staff-facing merchant record — includes operational contact details
 *  never shown on the public order page (see MerchantPublicDto for that). */
export interface MerchantDto {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  phone: string | null;
  email: string | null;
  /** parsed from the stored comma-separated field */
  notificationEmails: string[];
  pickupAddressText: string | null;
  pickupPoint: GeoPoint | null;
  businessHours: string | null;
  active: boolean;
  /** the full public order URL for this merchant, e.g. `${origin}/order/vbr-basics` */
  orderUrl: string;
  createdAt: string;
  updatedAt: string;
}

/** What the public `/order/:slug` page is allowed to know about a merchant —
 *  deliberately excludes phone/email/notificationEmails, same "never expose
 *  more than the public actually needs" rule as DispatchContactDto. A
 *  disabled/inactive merchant simply isn't returned (404), not returned
 *  with a flag — the public page never learns *why* a link doesn't work. */
export interface MerchantPublicDto {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  pickupAddressText: string | null;
  /** Whether this merchant has any active catalog products — if false, the
   *  public order form falls back to free-text item entry. */
  hasCatalog: boolean;
  businessHours: string | null;
}

/** A fleet operator — supplies riders rather than orders, the other side of
 *  the marketplace from Merchant (see schema.prisma's own doc comment).
 *  Staff-managed, same shape/pattern as MerchantDto but with no public
 *  storefront (no slug-based order link, no logo/catalog/business hours). */
export interface LogisticsCompanyDto {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  phone: string | null;
  email: string | null;
  active: boolean;
  riderCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductVariantDto {
  id: string;
  size: string | null;
  color: string | null;
  sku: string | null;
  /** effective price for this variant (override if set, else the product's own price) */
  price: Money;
  inventoryQty: number | null;
  active: boolean;
}

export interface ProductDto {
  id: string;
  merchantId: string;
  name: string;
  description: string | null;
  sku: string | null;
  photoUrl: string | null;
  category: string | null;
  price: Money;
  active: boolean;
  variants: ProductVariantDto[];
  createdAt: string;
  updatedAt: string;
}

/** One item as submitted on an order (public or staff) — a catalog pick
 *  (`productId`/`productVariantId`) or a free-text line (`name` + optional
 *  `unitPrice`, since a merchant with no catalog may have no fixed price
 *  yet and lets dispatch fill it in). The server always snapshots whatever
 *  price it resolves at creation time; a client-supplied `unitPrice` for a
 *  catalog item is never trusted over the real product/variant price. */
export interface OrderItemInput {
  productId?: string | null;
  productVariantId?: string | null;
  name?: string;
  size?: string | null;
  color?: string | null;
  quantity: number;
  unitPrice?: number | null;
  notes?: string | null;
}

/** POST /api/order (public, no merchant) or /api/order/:merchantSlug. */
export interface PublicOrderRequestInput {
  name: string;
  phone: string;
  email?: string | null;
  alternatePhone?: string | null;
  pickupAddressText?: string | null;
  addressText: string;
  addressProviderText?: string | null;
  landmark?: string | null;
  apartmentUnit?: string | null;
  point?: GeoPoint | null;
  items: OrderItemInput[];
  paymentMethod?: PaymentMethod;
  scheduledAt?: string | null;
  instructions?: string | null;
  consentTracking?: boolean;
}

/** What the public order form shows before submit, and what the real
 *  submission returns — the server-computed truth either way; a client
 *  never supplies (or can influence) `deliveryFee` or `total` directly. */
export interface PublicOrderPricingDto {
  subtotal: Money;
  deliveryFee: Money | null;
  /** false when the destination didn't resolve into any configured zone —
   *  the UI must show "delivery price requires confirmation", never invent one. */
  deliveryFeeConfirmed: boolean;
  total: Money;
}

export interface PublicOrderResultDto {
  jobId: string;
  jobNumber: string | null;
  merchantName: string | null;
  customerName: string;
  items: JobItemDto[];
  pricing: PublicOrderPricingDto;
  scheduledAt: string | null;
  tracking: TrackingLinkDto | null;
}

/** POST /api/order/quote (public, side-effect-free price preview) — the
 *  same pricing the real submission will compute, shown before the
 *  customer commits to "Place order". */
export interface PublicQuoteRequestDto {
  point: GeoPoint | null;
  items: OrderItemInput[];
  merchantSlug?: string | null;
}

/** A rider handing merchant COD cash to the office, recorded as a ledger
 *  entry — see the Settlement model's own doc comment in schema.prisma for
 *  how this differs from a rider `Payout` (their own earnings) and from
 *  the per-job CodEvent hand-in/approve trail (which this batches, not
 *  replaces). */
export interface SettlementDto {
  id: string;
  businessId: string;
  riderId: string;
  riderName: string;
  merchantId: string | null;
  merchantName: string | null;
  amount: Money;
  type: SettlementType;
  receivedById: string;
  receivedByName: string;
  reference: string | null;
  note: string | null;
  jobIds: string[];
  createdAt: string;
}

export interface CreateSettlementInput {
  riderId: string;
  merchantId?: string | null;
  amount: number;
  type?: SettlementType;
  jobIds: string[];
  reference?: string | null;
  note?: string | null;
}
