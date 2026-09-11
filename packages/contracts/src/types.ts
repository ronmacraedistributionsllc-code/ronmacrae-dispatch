import type {
  CodStatus,
  FailureReason,
  JobSource,
  JobStatus,
  JobType,
  NotificationChannel,
  NotificationStatus,
  PayoutMethod,
  PayoutStatus,
  PaymentStatus,
  Priority,
  ProofKind,
  ReconStatus,
  RiderStage,
  RiderStatus,
  Role,
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
}

export interface OperatingReportDto {
  filters: OperatingReportFilters;
  summary: OperatingReportSummaryDto;
  byRider: OperatingReportRiderRowDto[];
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
    /** units of the product in this order (1 when not stated) */
    quantity: number | null;
    /** product size / colour details (e.g. "Large", "Red") - kept separate for picking */
    itemSize: string | null;
    itemColor: string | null;
    packageSize: string | null;
    instructions: string | null;
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
  riderId: string | null;
  riderName: string | null;
  stage: RiderStage;
  routeSeq: number | null;
  scheduledAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface JobOfferDto {
  id: string;
  jobId: string;
  status: "open" | "accepted" | "declined" | "withdrawn" | "expired";
  expiresAt: string;
  pickupArea: string | null;
  destinationArea: string | null;
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
export interface BusinessSettings {
  businessName: string;
  dispatchPhone: string;
  dispatchWhatsApp: string;
  operationalCurrency: string;
  /** 1 USD -> X JMD, for dual currency display */
  usdToJmdRate: number | null;
  defaultZoneId: string | null;
  pinLength: number;
  trackingLinkTtlHours: number;
  /** true = bearer web location is best-effort; native app recommended */
  nativeAppRecommended: boolean;
}
