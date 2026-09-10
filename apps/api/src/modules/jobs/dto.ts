import type { Prisma } from "@prisma/client";
import type {
  AssignmentDto,
  JobDto,
  JobEventDto,
  JobSource,
  JobStatus,
  JobSummaryDto,
  ProofDto,
  TrackingLinkDto,
} from "@ronmacrae/contracts";
import { pointFromJson, moneyField } from "../../geo-mappers.js";

export type JobRow = Prisma.JobGetPayload<{ include: typeof jobInclude }>;

/** Shared Prisma include producing a `JobRow` (used by jobs, tracking and bearer). */
export const jobInclude = {
  customer: true,
  rider: true,
  zone: true,
  events: true,
  assignments: true,
  proofs: true,
  link: true,
} as const;

/** viewer context for field-level visibility (PIN etc.) */
export interface Viewer {
  role: string;
  riderId?: string | null;
}

/** the authenticated actor performing an action (audit + event attribution) */
export interface Actor {
  id: string | null;
  name: string | null;
  role: string;
  riderId?: string | null;
}

/** Map a session role onto the actor types recorded on job events. */
export function actorType(role: string | null): JobEventDto["actorType"] {
  if (role === "rider") return "rider";
  if (role === "admin" || role === "dispatcher") return "dispatcher";
  if (role === "customer") return "customer";
  if (role === "webhook") return "webhook";
  return "system";
}

/** rider sees the PIN only while the job is en route */
const PIN_STATUSES: JobStatus[] = ["picked_up", "in_transit", "delivering"];

export function pinVisibleFor(viewer: Viewer, job: { status: JobStatus; riderId: string | null }): boolean {
  if (viewer.role !== "rider") return true; // staff may always see the PIN
  if (!job.riderId || job.riderId !== viewer.riderId) return false;
  return PIN_STATUSES.includes(job.status);
}

export function jobToDto(
  job: JobRow,
  viewer: Viewer,
  appOrigin: string,
  extra?: { returnJobId?: string | null },
): JobDto {
  const cur = job.currency;
  return {
    id: job.id,
    jobNumber: job.jobNumber,
    source: job.source as JobSource,
    externalRef: job.externalRef,
    originalJobId: job.originalJobId,
    returnJobId: extra?.returnJobId ?? null,
    type: job.type,
    status: job.status,
    priority: job.priority,
    customerId: job.customerId,
    customerName: job.customer.name,
    customerPhone: job.customer.phone,
    addressText: job.addressText,
    landmark: job.landmark,
    point: pointFromJson(job.point),
    zoneId: job.zoneId,
    zoneName: job.zone?.name ?? null,
    pickupPoint: pointFromJson(job.pickupPoint),
    pickupAddressText: job.pickupAddressText,
    pickupContact: job.pickupContact,
    itemSummary: job.itemSummary,
    quantity: job.quantity,
    itemSize: job.itemSize,
    itemColor: job.itemColor,
    packageSize: job.packageSize,
    instructions: job.instructions,
    stage: job.stage,
    vehicle: job.vehicle,
    fare: moneyField(job.fare, cur),
    fee: moneyField(job.fee, cur),
    subtotal: moneyField(job.subtotal, cur),
    paymentMethod: job.paymentMethod,
    paymentStatus: job.paymentStatus,
    pin: pinVisibleFor(viewer, job) ? job.pin : null,
    amountExpected: moneyField(job.amountExpected, cur),
    amountCollected: moneyField(job.amountCollected, cur),
    failureReason: job.failureReason,
    failureNote: job.failureNote,
    scheduledAt: job.scheduledAt?.toISOString() ?? null,
    promisedAt: job.promisedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    riderId: job.rider?.id ?? null,
    riderName: job.rider?.name ?? null,
    routeSeq: job.routeSeq,
    routeEta: job.routeEta?.toISOString() ?? null,
    link: job.link ? linkToDto(job.link, appOrigin) : null,
    proofs: job.proofs.map(proofToDto),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export function jobSummaryToDto(job: JobRow): JobSummaryDto {
  const cur = job.currency;
  return {
    id: job.id,
    jobNumber: job.jobNumber,
    externalRef: job.externalRef,
    source: job.source as JobSource,
    type: job.type,
    status: job.status,
    priority: job.priority,
    customerName: job.customer.name,
    customerPhone: job.customer.phone,
    addressText: job.addressText,
    zoneName: job.zone?.name ?? null,
    itemSummary: job.itemSummary,
    quantity: job.quantity,
    itemSize: job.itemSize,
    itemColor: job.itemColor,
    paymentMethod: job.paymentMethod,
    paymentStatus: job.paymentStatus,
    amountExpected: moneyField(job.amountExpected, cur),
    riderId: job.rider?.id ?? null,
    riderName: job.rider?.name ?? null,
    stage: job.stage,
    scheduledAt: job.scheduledAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
  };
}

export function proofToDto(p: {
  id: string;
  jobId: string;
  kind: ProofDto["kind"];
  url: string;
  size: number;
  point: unknown;
  at: Date;
}): ProofDto {
  return {
    id: p.id,
    jobId: p.jobId,
    kind: p.kind,
    url: p.url,
    sizeBytes: p.size,
    point: pointFromJson(p.point),
    at: p.at.toISOString(),
  };
}

export function eventToDto(e: {
  id: string;
  jobId: string;
  from: string | null;
  to: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  note: string | null;
  meta: unknown;
  at: Date;
}): JobEventDto {
  return {
    id: e.id,
    jobId: e.jobId,
    from: (e.from as JobStatus | null) ?? null,
    to: e.to as JobStatus,
    actorType: e.actorType as JobEventDto["actorType"],
    actorId: e.actorId,
    actorName: e.actorName,
    note: e.note,
    meta: (e.meta as Record<string, unknown> | null) ?? null,
    at: e.at.toISOString(),
  };
}

export function assignmentToDto(a: {
  id: string;
  jobId: string;
  riderId: string;
  rider: { name: string };
  status: AssignmentDto["status"];
  reason: string | null;
  oldRiderId: string | null;
  at: Date;
}): AssignmentDto {
  return {
    id: a.id,
    jobId: a.jobId,
    riderId: a.riderId,
    riderName: a.rider.name,
    status: a.status,
    reason: a.reason,
    oldRiderId: a.oldRiderId,
    at: a.at.toISOString(),
  };
}

export function linkToDto(
  link: { id: string; jobId: string; token: string; expiresAt: Date; revoked: boolean; lastAccessAt: Date | null; createdAt: Date },
  appOrigin: string,
): TrackingLinkDto {
  return {
    id: link.id,
    jobId: link.jobId,
    token: link.token,
    url: `${appOrigin}/track/${link.token}`,
    expiresAt: link.expiresAt.toISOString(),
    revoked: link.revoked,
    lastAccessAt: link.lastAccessAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
  };
}
