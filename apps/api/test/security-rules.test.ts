/**
 * Proofs for platform security rules that had no dedicated test (see
 * store/SECURITY_RULES.md for the full rule → test map):
 *   1  private notifications stop after logout
 *   8  no plaintext passwords (stored, returned, or audited)
 *   9  roles are never client-controlled
 *   10/15  one business's admin can neither read nor edit another business's people,
 *          and can't re-credential someone who also works elsewhere
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";
import { hashPassword } from "../src/lib/password.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;
const PASSWORD = "correct-horse-1";

beforeAll(async () => {
  harness = await buildTestHarness("test-security-rules");
  await harness.prisma.business.update({ where: { id: harness.business.id }, data: { slug: "ronmacrae" } });
});
afterAll(async () => {
  await harness.cleanup();
});

async function makeBusiness() {
  return harness.prisma.business.create({ data: { name: `Biz ${uniq()}`, slug: `biz-${uniq()}` } });
}

async function makeStaff(role: "admin" | "dispatcher" | "viewer", businessId: string) {
  const user = await harness.prisma.user.create({
    data: { name: `Staff ${uniq()}`, email: `staff-${uniq()}@example.com`, passwordHash: hashPassword(PASSWORD), role },
  });
  await harness.prisma.staffMembership.create({ data: { userId: user.id, businessId, role, active: true } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role, businessId });
  return { user, token, auth: { authorization: `Bearer ${token}` } };
}

describe("rule 1 — private notifications stop after logout", () => {
  it("logout removes every push subscription the account had, on every device", async () => {
    const { user, auth } = await makeStaff("dispatcher", harness.business.id);
    for (const device of ["phone", "laptop"]) {
      await harness.prisma.pushSubscription.create({ data: { userId: user.id, endpoint: `https://push.example.com/${device}-${uniq()}`, p256dh: "k", auth: "a" } });
    }
    const other = await makeStaff("dispatcher", harness.business.id);
    await harness.prisma.pushSubscription.create({ data: { userId: other.user.id, endpoint: `https://push.example.com/other-${uniq()}`, p256dh: "k", auth: "a" } });

    const res = await harness.app.inject({ method: "POST", url: "/api/auth/logout", headers: auth });
    expect(res.statusCode).toBe(200);

    expect(await harness.prisma.pushSubscription.count({ where: { userId: user.id } })).toBe(0);
    // Someone else's devices are untouched.
    expect(await harness.prisma.pushSubscription.count({ where: { userId: other.user.id } })).toBe(1);
  });
});

describe("rule 8 — no plaintext passwords", () => {
  it("a created account stores only a hash, and no API response or audit entry carries the password or the hash", async () => {
    const admin = await makeStaff("admin", harness.business.id);
    const email = `new-${uniq()}@example.com`;
    const password = `S3cret-${uniq()}`;
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/users",
      headers: admin.auth,
      payload: { name: "Hash Check", email, password, role: "dispatcher" },
    });
    expect(created.statusCode).toBe(200);
    const listed = await harness.app.inject({ method: "GET", url: "/api/users", headers: admin.auth });

    for (const body of [created.body, listed.body]) {
      expect(body).not.toContain(password);
      expect(body).not.toMatch(/passwordHash|scrypt|\$2[aby]\$|totpSecret/i);
    }
    const row = await harness.prisma.user.findFirstOrThrow({ where: { email } });
    expect(row.passwordHash).not.toBe(password);
    expect(row.passwordHash).not.toContain(password);
    expect(row.passwordHash.length).toBeGreaterThan(30);

    const audit = JSON.stringify(await harness.prisma.auditLog.findMany());
    expect(audit).not.toContain(password);
  });
});

describe("rule 9 — roles are never client-controlled", () => {
  it("a public courier signup that smuggles in role / status fields still lands as a pending rider", async () => {
    const email = `smuggle-${uniq()}@example.com`;
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/rider-signup",
      payload: {
        name: "Role Smuggler", phone: `+1876555${uniq().slice(-4)}`, email, password: "riderpass1", vehicle: "car",
        role: "admin", platformRole: "owner", platformStatus: "approved", status: "active", businessId: "anything",
      },
    });
    expect(res.statusCode).toBe(200);
    const user = await harness.prisma.user.findFirstOrThrow({ where: { email }, include: { rider: true } });
    expect(user.role).toBe("rider");
    expect(user.platformRole).toBeNull();
    expect(user.rider?.platformStatus).not.toBe("approved");
    expect(await harness.prisma.staffMembership.count({ where: { userId: user.id } })).toBe(0);
  });

  it("only an admin can create accounts or change roles — a dispatcher is refused", async () => {
    const dispatcher = await makeStaff("dispatcher", harness.business.id);
    const target = await makeStaff("viewer", harness.business.id);
    const create = await harness.app.inject({ method: "POST", url: "/api/users", headers: dispatcher.auth, payload: { name: "X", email: `x-${uniq()}@example.com`, password: "longenough1", role: "admin" } });
    expect(create.statusCode).toBe(403);
    const promote = await harness.app.inject({ method: "PATCH", url: `/api/users/${target.user.id}`, headers: dispatcher.auth, payload: { role: "admin" } });
    expect(promote.statusCode).toBe(403);
    expect((await harness.prisma.user.findUniqueOrThrow({ where: { id: target.user.id } })).role).toBe("viewer");
  });
});

describe("rules 10 & 15 — one business can't see or edit another's people", () => {
  it("GET /api/users lists only this business's people — never another company's staff, or the platform owner", async () => {
    const bizA = await makeBusiness();
    const bizB = await makeBusiness();
    const adminA = await makeStaff("admin", bizA.id);
    const staffA = await makeStaff("viewer", bizA.id);
    const adminB = await makeStaff("admin", bizB.id);
    const owner = await harness.prisma.user.create({ data: { name: "The Owner", email: `owner-${uniq()}@example.com`, passwordHash: hashPassword(PASSWORD), role: "admin", platformRole: "owner" } });

    const res = await harness.app.inject({ method: "GET", url: "/api/users", headers: adminA.auth });
    const ids = (res.json() as { users: { id: string }[] }).users.map((u) => u.id);
    expect(ids).toEqual(expect.arrayContaining([adminA.user.id, staffA.user.id]));
    expect(ids).not.toContain(adminB.user.id);
    expect(ids).not.toContain(owner.id);
  });

  it("an admin cannot edit, re-password, disable or promote someone from another business or the platform owner — they simply aren't found", async () => {
    const bizA = await makeBusiness();
    const bizB = await makeBusiness();
    const adminA = await makeStaff("admin", bizA.id);
    const victim = await makeStaff("admin", bizB.id);
    const owner = await harness.prisma.user.create({ data: { name: "The Owner", email: `owner2-${uniq()}@example.com`, passwordHash: hashPassword(PASSWORD), role: "admin", platformRole: "owner" } });

    for (const target of [victim.user, owner]) {
      const before = await harness.prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      for (const payload of [{ password: "attacker-chosen-1" }, { active: false }, { email: "attacker@example.com" }, { name: "Pwned" }]) {
        const res = await harness.app.inject({ method: "PATCH", url: `/api/users/${target.id}`, headers: adminA.auth, payload });
        expect(res.statusCode).toBe(404);
      }
      const after = await harness.prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(after.email).toBe(before.email);
      expect(after.active).toBe(true);
      expect(after.name).toBe(before.name);
    }
  });

  it("within the business an admin can manage staff — role change moves the membership too, and a password reset signs the person out", async () => {
    const biz = await makeBusiness();
    const admin = await makeStaff("admin", biz.id);
    const member = await makeStaff("viewer", biz.id);
    await harness.prisma.session.create({ data: { userId: member.user.id, tokenHash: `h-${uniq()}`, expiresAt: new Date(Date.now() + 3_600_000) } });

    const res = await harness.app.inject({ method: "PATCH", url: `/api/users/${member.user.id}`, headers: admin.auth, payload: { role: "dispatcher", password: "brand-new-pass-1" } });
    expect(res.statusCode).toBe(200);
    const membership = await harness.prisma.staffMembership.findFirstOrThrow({ where: { userId: member.user.id, businessId: biz.id } });
    expect(membership.role).toBe("dispatcher");
    expect(await harness.prisma.session.count({ where: { userId: member.user.id } })).toBe(0);
  });

  it("a person who also works elsewhere can't be re-credentialed by one business — only renamed", async () => {
    const bizA = await makeBusiness();
    const bizB = await makeBusiness();
    const adminA = await makeStaff("admin", bizA.id);
    const shared = await makeStaff("dispatcher", bizA.id);
    await harness.prisma.staffMembership.create({ data: { userId: shared.user.id, businessId: bizB.id, role: "admin", active: true } });
    const before = await harness.prisma.user.findUniqueOrThrow({ where: { id: shared.user.id } });

    for (const payload of [{ password: "attacker-chosen-1" }, { email: "attacker@example.com" }, { active: false }, { role: "viewer" }]) {
      const res = await harness.app.inject({ method: "PATCH", url: `/api/users/${shared.user.id}`, headers: adminA.auth, payload });
      expect(res.statusCode).toBe(409);
    }
    const after = await harness.prisma.user.findUniqueOrThrow({ where: { id: shared.user.id } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.email).toBe(before.email);
    expect(after.active).toBe(true);

    const rename = await harness.app.inject({ method: "PATCH", url: `/api/users/${shared.user.id}`, headers: adminA.auth, payload: { name: "Renamed Person" } });
    expect(rename.statusCode).toBe(200);
  });
});

describe("rule 10 — delivery proof photos stay inside their business", () => {
  async function makeJob(businessId: string, riderId?: string) {
    const customer = await harness.prisma.customer.create({ data: { businessId, name: "Proof Customer", phone: `+1876555${uniq().slice(-4)}` } });
    return harness.prisma.job.create({
      data: { businessId, customerId: customer.id, jobNumber: `P-${uniq()}`, type: "delivery", status: "assigned", riderId: riderId ?? null, addressText: "1 Test Rd", pickupAddressText: "2 Test Rd", pin: "1234" },
    });
  }

  function multipart(kind: string): { payload: Buffer; headers: Record<string, string> } {
    const boundary = `----proof${uniq()}`;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
  }

  it("another company's staff can neither attach a proof to a job nor download one; the owning business's staff can", async () => {
    const bizA = await makeBusiness();
    const bizB = await makeBusiness();
    const staffA = await makeStaff("dispatcher", bizA.id);
    const staffB = await makeStaff("dispatcher", bizB.id);
    const job = await makeJob(bizA.id);

    const forb = multipart("delivery_photo");
    const denied = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/proofs`, headers: { ...staffB.auth, ...forb.headers }, payload: forb.payload });
    expect(denied.statusCode).toBe(403);
    expect(await harness.prisma.proof.count({ where: { jobId: job.id } })).toBe(0);

    const ok = multipart("delivery_photo");
    const accepted = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/proofs`, headers: { ...staffA.auth, ...ok.headers }, payload: ok.payload });
    expect(accepted.statusCode).toBe(200);
    const key = (accepted.json() as { proof: { url: string } }).proof.url.split("/").pop()!;

    expect((await harness.app.inject({ method: "GET", url: `/api/proofs/${key}`, headers: staffB.auth })).statusCode).toBe(403);
    expect((await harness.app.inject({ method: "GET", url: `/api/proofs/${key}`, headers: staffA.auth })).statusCode).toBe(200);
  });
});
