/** Canonical role set. Riders are users with role `rider` (app/bearer face). */
export const ROLES = ["admin", "dispatcher", "accountant", "viewer", "rider"] as const;
export type Role = (typeof ROLES)[number];

/** Roles allowed on the dispatcher web face. */
export const STAFF_ROLES = ["admin", "dispatcher", "accountant", "viewer"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Platform-wide authority, separate from (and not implying) membership in
 *  any specific business — see Business/StaffMembership/RiderMembership. */
export const PLATFORM_ROLES = ["owner"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Whether a rider may work through the open network at all — a
 *  platform-owner-controlled gate, independent of any one business's own
 *  membership decision (see RiderMembershipStatus). */
export const PLATFORM_RIDER_STATUSES = ["pending", "approved", "suspended"] as const;
export type PlatformRiderStatus = (typeof PLATFORM_RIDER_STATUSES)[number];

/** A rider's relationship with one specific business. Can only reach
 *  `active` once the rider also holds platform-level approval. */
export const RIDER_MEMBERSHIP_STATUSES = ["pending", "active", "suspended", "removed"] as const;
export type RiderMembershipStatus = (typeof RIDER_MEMBERSHIP_STATUSES)[number];

/** Whether a global CustomerIdentity's phone has actually been proven, or
 *  is just what a business typed in — see the model's own doc comment in
 *  schema.prisma (Stage 23, spec section 6). The only way to reach
 *  `verified` today is the customer-dashboard's own phone-OTP flow. */
export const CUSTOMER_IDENTITY_STATUSES = ["provisional", "verified"] as const;
export type CustomerIdentityStatus = (typeof CUSTOMER_IDENTITY_STATUSES)[number];

/**
 * Internal workflow statuses.
 * Store outcomes the dispatcher must distinguish: customer not answering,
 * changed location, cancelled, returned (package back at the store) and failed.
 */
export const JOB_STATUSES = [
  "new",
  "assigned",
  "accepted",
  "picked_up",
  "in_transit",
  "delivering",
  "delivered",
  "no_answer",
  "location_changed",
  "failed",
  "returned",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = ["pickup", "delivery", "pickup_delivery", "return"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const PRIORITIES = ["normal", "express", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * How the customer settles the order. `cod` = pays the courier in cash;
 * `online` = already paid online (store/web checkout); card/transfer = prepaid.
 * Everything except `cod` is treated as paid up front (no cash for the rider).
 */
export const PAYMENT_METHODS = ["cod", "online", "card", "transfer"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ["unpaid", "partial", "paid"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Full COD reconciliation lifecycle for one job — independent of
 * `PaymentStatus` (which only tracks whether *enough* was collected).
 * pending_collection -> collected -> handed_in -> approved, with `disputed`
 * reachable from collected/handed_in (and from approved, as a deliberate
 * accountant re-open) instead of approved.
 */
export const COD_STATUSES = ["pending_collection", "collected", "handed_in", "disputed", "approved"] as const;
export type CodStatus = (typeof COD_STATUSES)[number];

/**
 * Where a delivery order came from. Knutsford / Zipmail / courier are the
 * store's own channels; `manual` is staff-keyed, `web` is the public
 * delivery-request form, `woo` is the online store sync.
 */
export const JOB_SOURCES = ["manual", "web", "knutsford", "zipmail", "courier", "woo"] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

export const VEHICLE_TYPES = ["motorcycle", "car"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const RIDER_STATUSES = ["offline", "available", "on_job", "unavailable"] as const;
export type RiderStatus = (typeof RIDER_STATUSES)[number];

/**
 * Sub-progress inside a `JobStatus` for the rider (bearer) face.
 * Stages are recorded as job events with `to` equal to the current status;
 * they are never a full status transition on their own.
 */
export const RIDER_STAGES = ["none", "heading_to_pickup", "at_pickup", "heading_to_dropoff"] as const;
export type RiderStage = (typeof RIDER_STAGES)[number];

export const RIDER_STAGE_LABELS: Record<RiderStage, string> = {
  none: "Not started",
  heading_to_pickup: "Heading to pickup",
  at_pickup: "At pickup",
  heading_to_dropoff: "Heading to destination",
};

export const FAILURE_REASONS = [
  "no_answer",
  "refused",
  "wrong_number",
  "address_not_found",
  "damaged",
  "absent",
  "other",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const FAILURE_REASON_LABELS: Record<FailureReason, string> = {
  no_answer: "No answer at the door",
  refused: "Customer refused the delivery",
  wrong_number: "Wrong phone number",
  address_not_found: "Address / landmark not found",
  damaged: "Package damaged in transit",
  absent: "Customer absent, cannot reschedule",
  other: "Other (see note)",
};

export const NOTIFICATION_CHANNELS = ["whatsapp", "sms", "push", "in_app"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * queued/sending: not yet handed to the provider (Pending in the UI).
 * sent: the provider *accepted* it for delivery — this is NOT delivery
 *   confirmation (a real provider's send-API call succeeding only means it
 *   was queued on their end; actual delivery is a separate, later signal —
 *   see the Twilio status callback in notify.ts). Only a provider telling us
 *   so (a delivery receipt/webhook) moves a message to `delivered`.
 * delivered: confirmed by the provider.
 * failed: the provider rejected it, or later reported non-delivery.
 * suppressed: skipped on purpose (e.g. no customer consent) — shown as
 *   "Skipped" in the UI, never silently dropped.
 */
export const NOTIFICATION_STATUSES = [
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed",
  "suppressed",
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Who sent one delivery-chat message (spec 5G). "system" is a small set of
 *  fixed announcements (e.g. an address-change decision) — never
 *  user-composed text pretending to be automated, and never the other way
 *  around. */
export const MESSAGE_SENDER_ROLES = ["customer", "rider", "dispatcher", "system"] as const;
export type MessageSenderRole = (typeof MESSAGE_SENDER_ROLES)[number];

/** A customer/rider proposing a new destination in chat is never applied
 *  automatically — dispatch reviews and approves/declines it explicitly. */
export const ADDRESS_CHANGE_STATUSES = ["pending", "approved", "declined"] as const;
export type AddressChangeStatus = (typeof ADDRESS_CHANGE_STATUSES)[number];

export const PROOF_KINDS = [
  "pickup_photo",
  "delivery_photo",
  "receipt_photo",
  "signature",
  "package_photo",
] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];

export const SOS_STATUSES = ["active", "acknowledged", "resolved"] as const;
export type SosStatus = (typeof SOS_STATUSES)[number];

export const CONSENT_SCOPES = ["live_tracking", "marketing", "contacts"] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export const RECON_STATUSES = [
  "open",
  "matched",
  "shortage",
  "overage",
  "investigating",
  "resolved",
] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];

export const PAYOUT_STATUSES = ["draft", "approved", "paid"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const PAYOUT_METHODS = ["cash", "bank_transfer", "wire", "wipay"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

/**
 * Honest location-tracking states for the bearer client.
 * A PWA cannot guarantee locked-screen GPS; the UI must always surface
 * which of these states applies instead of implying continuous tracking.
 */
export const TRACKING_STATES = ["active", "degraded", "paused", "unavailable"] as const;
export type TrackingState = (typeof TRACKING_STATES)[number];

export const TRACKING_STATE_LABELS: Record<TrackingState, string> = {
  active: "Live tracking active",
  degraded: "Tracking degraded (weak GPS)",
  paused: "Tracking paused (app backgrounded/locked)",
  unavailable: "Tracking unavailable (permission or no signal)",
};

/**
 * Customer-facing projection of job status (for the tracking link page).
 * The unhappy paths are shown distinctly: not answering, changed location,
 * failed, returned, cancelled.
 */
export const CUSTOMER_JOB_STATUSES = [
  "confirmed",
  "assigned",
  "picked_up",
  "out_for_delivery",
  "delivered",
  "no_answer",
  "location_changed",
  "failed",
  "returned",
  "cancelled",
] as const;
export type CustomerJobStatus = (typeof CUSTOMER_JOB_STATUSES)[number];

export const CUSTOMER_JOB_STATUS_LABELS: Record<CustomerJobStatus, string> = {
  confirmed: "Delivery confirmed",
  assigned: "Courier on the way",
  picked_up: "Package picked up",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  no_answer: "No answer at the door",
  location_changed: "Delivery location changed",
  failed: "Delivery failed",
  returned: "Package returned to the store",
  cancelled: "Cancelled",
};

export function toCustomerStatus(status: JobStatus): CustomerJobStatus {
  switch (status) {
    case "new":
      return "confirmed";
    case "assigned":
    case "accepted":
      return "assigned";
    case "picked_up":
      return "picked_up";
    case "in_transit":
    case "delivering":
      return "out_for_delivery";
    case "delivered":
      return "delivered";
    case "no_answer":
      return "no_answer";
    case "location_changed":
      return "location_changed";
    case "failed":
      return "failed";
    case "returned":
      return "returned";
    case "cancelled":
      return "cancelled";
  }
}
