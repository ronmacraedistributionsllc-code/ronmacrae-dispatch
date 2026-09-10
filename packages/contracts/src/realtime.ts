import type {
  JobDto,
  JobEventDto,
  JobOfferDto,
  RouteDto,
  RiderLocationDto,
  SosAlertDto,
} from "./types.js";
import type { JobStatus, TrackingState } from "./enums.js";

/**
 * Realtime message protocol.
 * Server -> client, JSON over WebSocket at `GET /ws?token=<access>` (or the
 * customer page uses polling instead; realtime is optional for it).
 */
export type RealtimeMessage =
  | { type: "rider.location"; payload: RiderLocationDto }
  | { type: "rider.status"; payload: { riderId: string; status: string } }
  | { type: "job.state"; payload: { job: JobDto; event: JobEventDto } }
  | { type: "job.assigned"; payload: { job: JobDto; riderId: string } }
  | { type: "job.rerouted"; payload: { jobId: string; route: RouteDto } }
  | { type: "job.eta"; payload: { jobId: string; riderId: string; etaAt: string | null } }
  | { type: "bearer.tracking"; payload: { bearerId: string; state: TrackingState; reason: string | null } }
  | { type: "sos"; payload: SosAlertDto }
  | { type: "notification"; payload: OutboundNotificationEvent }
  | { type: "offer"; payload: JobOfferDto };

/** Server connection-management messages, outside the application message union above. */
export type RealtimeSystemMessage =
  | { type: "hello"; payload: { user: { id: string; name: string; role: string; riderId: string | null }; rooms: string[]; origin: string } }
  | { type: "joined"; rooms: string[] };

export interface OutboundNotificationEvent {
  id: string;
  channel: string;
  to: string;
  template: string;
  status: string;
  at: string;
}

/** Client -> server realtime messages. */
export type RealtimeClientMessage =
  | { type: "ack"; messageIds: string[] }
  | { type: "bearer.tracking"; state: TrackingState; reason?: string };

/** Rooms a client can join after auth (server validates membership). */
export const ROOM_DISPATCH = "dispatch";
export const roomForRider = (riderId: string): string => `rider:${riderId}`;
export const roomForJob = (jobId: string): string => `job:${jobId}`;
export const roomForCustomer = (customerId: string): string => `customer:${customerId}`;

/** Job statuses that broadcast `job.state` to the customer room (for WS-capable clients). */
export const CUSTOMER_BROADCAST_STATUSES: JobStatus[] = [
  "picked_up",
  "in_transit",
  "delivering",
  "delivered",
  "no_answer",
  "location_changed",
  "failed",
  "returned",
  "cancelled",
];
