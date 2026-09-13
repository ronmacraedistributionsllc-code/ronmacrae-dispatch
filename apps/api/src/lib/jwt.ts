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

/** A phone-verified, read-only session for the cross-business customer
 *  package dashboard (Stage 22) — deliberately its own token `type` (not
 *  "access"), so it is structurally impossible for it to satisfy
 *  verifyAccess()/requireStaff()/requireRider() no matter what a guard
 *  forgets to check. Carries no user id, role or businessId — only the
 *  phone number it was issued for. */
export interface CustomerDashboardTokenPayload {
  phone: string; // normalized, see lib/phone.ts
  type: "customer_dashboard";
}

/** A merchant's own portal session — its own token `type`, same rationale
 *  as CustomerDashboardTokenPayload: structurally cannot satisfy
 *  verifyAccess()/requireStaff() no matter what a guard forgets to check.
 *  Scoped to exactly one merchant, never a whole Business. */
export interface MerchantPortalTokenPayload {
  sub: string; // user id
  merchantId: string;
  type: "merchant_portal";
}

const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_DAYS = 30;
export const CUSTOMER_DASHBOARD_TTL_S = 24 * 3600;
export const MERCHANT_PORTAL_TTL_S = 24 * 3600;

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

  async issueCustomerDashboard(phone: string): Promise<string> {
    return new SignJWT({ phone, type: "customer_dashboard" } as JWTPayload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${CUSTOMER_DASHBOARD_TTL_S}s`)
      .sign(this.secret);
  }

  async verifyCustomerDashboard(token: string): Promise<CustomerDashboardTokenPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret);
      if (payload.type !== "customer_dashboard" || typeof payload.phone !== "string") return null;
      return payload as unknown as CustomerDashboardTokenPayload;
    } catch {
      return null;
    }
  }

  async issueMerchantPortal(userId: string, merchantId: string): Promise<string> {
    return new SignJWT({ merchantId, type: "merchant_portal" } as JWTPayload)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${MERCHANT_PORTAL_TTL_S}s`)
      .sign(this.secret);
  }

  async verifyMerchantPortal(token: string): Promise<MerchantPortalTokenPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret);
      if (payload.type !== "merchant_portal" || typeof payload.merchantId !== "string" || typeof payload.sub !== "string") return null;
      return payload as unknown as MerchantPortalTokenPayload;
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
