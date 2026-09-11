import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { AccessTokenPayload, JwtIssuer } from "../lib/jwt.js";
import { ACTIVE_JOB_STATUSES, roomForDispatch, roomForRider, roomForJob, type RealtimeMessage } from "@ronmacrae/contracts";
import type { Logger } from "../lib/log.js";
import type { PrismaClient } from "@prisma/client";

/**
 * In-process realtime hub.
 *
 * Clients connect to `GET /ws?token=<accessToken>`. On connect the server
 * validates the JWT and joins role-appropriate rooms:
 *   staff -> dispatch
 *   rider -> rider:<ownId> + rooms of their active jobs
 *
 * Single-process by design (bootstrapped deploy). The broadcast API here is
 * the seam for swapping in a Redis-adapter hub (or Ably/PubNub) later.
 */
export interface ClientState {
  id: string;
  socket: WebSocket;
  user: AccessTokenPayload;
  riderId: string | null;
  rooms: Set<string>;
  lastAck: number;
}

type AnyRtMessage = RealtimeMessage | { type: string; payload?: unknown; rooms?: string[] };

export class RealtimeHub {
  private clients = new Map<string, ClientState>();
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly jwt: JwtIssuer,
    private readonly prisma: PrismaClient,
    private readonly log: Logger,
    private readonly appOrigin: string,
  ) {}

  get clientCount(): number {
    return this.clients.size;
  }

  clientForRider(riderId: string): ClientState | undefined {
    return [...this.clients.values()].find((c) => c.riderId === riderId);
  }

  async handleSocket(socket: WebSocket, token: string): Promise<void> {
    const payload = await this.jwt.verifyAccess(token);
    if (!payload) {
      socket.close(4401, "unauthorized");
      return;
    }
    let riderId: string | null = null;
    if (payload.role === "rider") {
      const rider = await this.prisma.rider.findFirst({ where: { userId: payload.sub } });
      riderId = rider?.id ?? null;
    }
    const state: ClientState = {
      id: randomUUID(),
      socket,
      user: { ...payload, riderId: riderId ?? undefined },
      riderId,
      rooms: new Set<string>(),
      lastAck: Date.now(),
    };
    // Owner sessions (platform-wide, no fixed businessId) don't join any
    // per-business dispatch room — the owner console has its own,
    // separate, cross-business endpoints rather than tapping into every
    // business's live feed.
    if (payload.role !== "rider" && payload.businessId) state.rooms.add(roomForDispatch(payload.businessId));
    if (riderId) {
      state.rooms.add(roomForRider(riderId));
      const jobs = await this.prisma.job.findMany({
        where: {
          riderId,
          status: { in: ACTIVE_JOB_STATUSES },
        },
        select: { id: true },
      });
      for (const j of jobs) state.rooms.add(roomForJob(j.id));
    }
    this.clients.set(state.id, state);
    this.sendTo(state, {
      type: "hello",
      payload: { user: { id: payload.sub, name: payload.name, role: payload.role, riderId }, rooms: [...state.rooms], origin: this.appOrigin },
    });

    socket.on("message", (raw: Buffer | string) => {
      void this.onMessage(state, String(raw));
    });
    const onClose = () => this.clients.delete(state.id);
    socket.on("close", onClose);
    socket.on("error", onClose);
    socket.on("pong", () => {
      state.lastAck = Date.now();
    });
    this.log.debug({ role: payload.role, riderId }, "rt client connected");
  }

  private async onMessage(state: ClientState, raw: string): Promise<void> {
    let msg: { type: string; rooms?: string[] };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "join" && Array.isArray(msg.rooms)) {
      for (const room of msg.rooms) {
        if (await this.mayJoin(state, room)) state.rooms.add(room);
      }
      this.sendTo(state, { type: "joined", rooms: [...state.rooms] });
    }
  }

  private async mayJoin(state: ClientState, room: string): Promise<boolean> {
    if (state.user.role === "rider") {
      if (room.startsWith("dispatch:")) return false;
      if (room === roomForRider(state.user.riderId ?? "")) return true;
      if (room.startsWith("job:")) {
        const job = await this.prisma.job.findFirst({
          where: { id: room.slice(4), riderId: state.user.riderId },
          select: { id: true },
        });
        return Boolean(job);
      }
      return false;
    }
    // Staff: only their own business's dispatch room, and only job/customer
    // rooms belonging to a job in their own business — never another
    // business's live feed, even on an explicit join request.
    if (room.startsWith("dispatch:")) return room === roomForDispatch(state.user.businessId ?? "");
    if (room.startsWith("job:")) {
      const job = await this.prisma.job.findFirst({ where: { id: room.slice(4), businessId: state.user.businessId ?? "__none__" }, select: { id: true } });
      return Boolean(job);
    }
    if (room.startsWith("customer:")) {
      const customer = await this.prisma.customer.findFirst({ where: { id: room.slice(9), businessId: state.user.businessId ?? "__none__" }, select: { id: true } });
      return Boolean(customer);
    }
    return false;
  }

  sendTo(client: ClientState, msg: AnyRtMessage): void {
    if (client.socket.readyState === 1) client.socket.send(JSON.stringify(msg));
  }

  broadcast(room: string, msg: AnyRtMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients.values()) {
      if (client.rooms.has(room) && client.socket.readyState === 1) client.socket.send(data);
    }
  }

  broadcastMany(rooms: Iterable<string>, msg: AnyRtMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients.values()) {
      if (client.socket.readyState !== 1) continue;
      for (const room of rooms) {
        if (client.rooms.has(room)) {
          client.socket.send(data);
          break;
        }
      }
    }
  }

  startPing(): void {
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      for (const client of this.clients.values()) {
        if (now - client.lastAck > 45_000) client.socket.close(4000, "heartbeat timeout");
        else client.socket.ping();
      }
    }, 25_000);
    this.pingTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const client of this.clients.values()) client.socket.close(1001, "server shutting down");
    this.clients.clear();
  }
}
