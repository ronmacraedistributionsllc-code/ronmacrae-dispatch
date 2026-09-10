import type { GeoPoint } from "@ronmacrae/contracts";
import { roomForRider, roomForJob, ROOM_DISPATCH } from "@ronmacrae/contracts";
import type { PrismaClient } from "../prisma.js";
import type { RealtimeHub } from "./hub.js";
import type { Logger } from "../lib/log.js";
import { pointToJson } from "../geo-mappers.js";

interface SimLeg {
  jobId: string;
  riderId: string;
  from: GeoPoint;
  to: GeoPoint;
  durationMs: number;
  startedAt: number;
  clientSeq: number;
}

const TICK_MS = 5_000;
const MIN_SIM_MS = 45_000;
const MAX_SIM_MS = 5 * 60_000;
const ACTIVE_STATUSES = ["assigned", "accepted", "picked_up", "in_transit", "delivering"] as const;

/**
 * Simulated rider location until a real mapping/telemetry source exists.
 *
 * The jobs module starts a leg when the rider heads to the pickup or the
 * destination. While the leg is active the rider "moves" along the straight
 * line at a preview-compressed speed, writing RiderLocation rows and
 * broadcasting `rider.location` exactly like the future native app would.
 *
 * The rider face's own `rider-locations/:id/report` endpoint feeds the same
 * pipeline, so the web bearer app can override the simulation with real GPS
 * whenever the browser grants location access.
 */
export class LocationSimulator {
  private legs = new Map<string, { timer: NodeJS.Timeout; leg: SimLeg }>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly hub: RealtimeHub,
    private readonly log: Logger,
  ) {}

  get activeCount(): number {
    return this.legs.size;
  }

  /** Begin (or restart) a simulated leg. The previous leg for this job is stopped. */
  startForJob(input: { jobId: string; riderId: string; from: GeoPoint; to: GeoPoint; durationS: number }): void {
    this.stopForJob(input.jobId);
    const durationMs = Math.min(Math.max(input.durationS * 1000, MIN_SIM_MS), MAX_SIM_MS);
    const leg: SimLeg = { ...input, durationMs, startedAt: Date.now(), clientSeq: 1 };
    const timer = setInterval(() => void this.tick(leg.jobId), TICK_MS);
    timer.unref?.();
    this.legs.set(leg.jobId, { timer, leg });
    this.log.debug(
      { jobId: input.jobId, from: input.from, to: input.to, durationMs },
      "location sim leg started",
    );
    void this.tick(leg.jobId);
  }

  stopForJob(jobId: string): void {
    const entry = this.legs.get(jobId);
    if (!entry) return;
    clearInterval(entry.timer);
    this.legs.delete(jobId);
  }

  /** Stop the leg and leave the rider frozen at the leg's end point. */
  async stopAndLand(jobId: string): Promise<void> {
    const entry = this.legs.get(jobId);
    if (!entry) return;
    clearInterval(entry.timer);
    this.legs.delete(jobId);
    await this.writeLocation(entry.leg, entry.leg.to, entry.leg.clientSeq, "active");
  }

  async stopAll(): Promise<void> {
    for (const jobId of [...this.legs.keys()]) this.stopForJob(jobId);
  }

  /** Stop the leg once the job leaves the active set (terminal status / reassigned). */
  async reconcileJob(jobId: string, status: string, riderId: string | null): Promise<void> {
    const entry = this.legs.get(jobId);
    if (!entry) return;
    const stillActive = ACTIVE_STATUSES.includes(status as (typeof ACTIVE_STATUSES)[number]);
    if (stillActive && entry.leg.riderId === riderId) return;
    await this.stopAndLand(jobId);
  }

  private async tick(jobId: string): Promise<void> {
    const entry = this.legs.get(jobId);
    if (!entry) return;
    const { leg } = entry;
    const job = await this.prisma.job
      .findUnique({ where: { id: jobId }, select: { status: true, riderId: true } })
      .catch(() => null);
    if (!job) {
      this.stopForJob(jobId);
      return;
    }
    if (!ACTIVE_STATUSES.includes(job.status as (typeof ACTIVE_STATUSES)[number]) || job.riderId !== leg.riderId) {
      await this.stopAndLand(jobId);
      return;
    }
    const t = Math.min(1, (Date.now() - leg.startedAt) / leg.durationMs);
    await this.writeLocation(leg, lerp(leg.from, leg.to, t), leg.clientSeq, "active");
    if (t >= 1) this.stopForJob(jobId);
  }

  private async writeLocation(leg: SimLeg, point: GeoPoint, seq: number, state: string): Promise<void> {
    leg.clientSeq = seq + 1;
    await this.prisma.riderLocation
      .create({
        data: {
          riderId: leg.riderId,
          point: pointToJson(point) as object,
          trackingState: state,
          clientSeq: seq,
        },
      })
      .catch((err) => this.log.warn({ err: String(err), jobId: leg.jobId }, "sim location write failed"));
    this.hub.broadcastMany(
      [roomForRider(leg.riderId), roomForJob(leg.jobId), ROOM_DISPATCH],
      {
        type: "rider.location",
        payload: {
          id: `sim-${leg.jobId}-${seq}`,
          riderId: leg.riderId,
          point,
          heading: null,
          speedKph: null,
          batteryPct: null,
          trackingState: state as "active" | "degraded" | "paused" | "unavailable",
          at: new Date().toISOString(),
        },
      },
    );
  }
}

function lerp(a: GeoPoint, b: GeoPoint, t: number): GeoPoint {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}
