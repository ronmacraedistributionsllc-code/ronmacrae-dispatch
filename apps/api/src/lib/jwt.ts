import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { createHash, randomBytes } from "node:crypto";
import type { PlatformRole, Role } from "@ronmacrae/contracts";

export interface AccessTokenPayload {
  sub: string; // user id
  name: string;
  /** For staff, this is their role AT `businessId` below (from their
   *  StaffMembership) — not a global role. For a rider, `role: "rider"` and
   *  `businessId` is absent (a rider's access is per-job via
   *  RiderMembership, not one fixed session business). */
  role: Role;
  riderId?: string;
  /** The business this staff session is scoped to. Absent for riders and for
   *  a platform-owner session (platformRole below), which is not tied to any
   *  single business. */
  businessId?: string;
  /** Platform-wide authority — see the Business/StaffMembership model doc.
   *  Independent of, and does not imply, membership in any business. */
  platformRole?: PlatformRole;
  type: "access";
}

export interface RefreshTokenPayload {
  sub: string; // user id
  jti: string; // session id
  type: "refresh";
}

const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_DAYS = 30;

export class JwtIssuer {
  private secret: Uint8Array;

  constructor(sessionSecret: string) {
    this.secret = new TextEncoder().encode(sessionSecret);
  }

  async issueAccess(user: { id: string; name: string; role: Role; riderId?: string; businessId?: string; platformRole?: PlatformRole }): Promise<string> {
    const payload = {
      name: user.name,
      role: user.role,
      ...(user.riderId ? { riderId: user.riderId } : {}),
      ...(user.businessId ? { businessId: user.businessId } : {}),
      ...(user.platformRole ? { platformRole: user.platformRole } : {}),
      type: "access" as const,
    };
    return new SignJWT(payload as JWTPayload)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_S}s`)
      .sign(this.secret);
  }

  async issueRefresh(user: { id: string }, sessionJti: string): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);
    const token = await new SignJWT({ type: "refresh" } as JWTPayload)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setJti(sessionJti)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(this.secret);
    return { token, expiresAt };
  }

  async verifyAccess(token: string): Promise<AccessTokenPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret);
      if (payload.type !== "access") return null;
      return payload as unknown as AccessTokenPayload;
    } catch {
      return null;
    }
  }

  async verifyRefresh(token: string): Promise<RefreshTokenPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret);
      if (payload.type !== "refresh" || !payload.jti) return null;
      return payload as unknown as RefreshTokenPayload;
    } catch {
      return null;
    }
  }
}

/** SHA-256 of a refresh token for at-rest storage. */
export function hashToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

export function newJti(): string {
  return randomBytes(16).toString("hex");
}
