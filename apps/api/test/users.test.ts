/**
 * Regression test: POST /api/users used to create a bare User with no
 * StaffMembership at all, so the account it just created could never
 * actually log in — resolveStaffContext (auth.ts) rejects any non-rider
 * staff user with zero active memberships with 403 "no active business
 * membership". This asserts the new account can really sign in, not just
 * that the create call itself returns 200.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function adminToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Admin ${uniq()}`, passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", businessId: h.business.id });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-users");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("POST /api/users", () => {
  it("creates a dispatcher who can actually log in with the given password", async () => {
    const auth = await adminToken(harness);
    const email = `dispatch-${uniq()}@example.com`;
    const create = await harness.app.inject({
      method: "POST",
      url: "/api/users",
      headers: { authorization: `Bearer ${auth}` },
      payload: { name: "Dwayne Dispatch", email, password: "dispatch1234", role: "dispatcher" },
    });
    expect(create.statusCode).toBe(200);
    const { user } = create.json() as { user: { id: string; role: string } };
    expect(user.role).toBe("dispatcher");

    const membership = await harness.prisma.staffMembership.findUnique({
      where: { userId_businessId: { userId: user.id, businessId: harness.business.id } },
    });
    expect(membership?.active).toBe(true);
    expect(membership?.role).toBe("dispatcher");

    const login = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: email, password: "dispatch1234" },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { businessId: string; user: { role: string } };
    expect(body.user.role).toBe("dispatcher");
    expect(body.businessId).toBe(harness.business.id);
  });

  it("still creates a rider without a StaffMembership (riders are scoped a different way)", async () => {
    const auth = await adminToken(harness);
    const phone = `+1876555${uniq().slice(-4)}`;
    const create = await harness.app.inject({
      method: "POST",
      url: "/api/users",
      headers: { authorization: `Bearer ${auth}` },
      payload: { name: "Kei Bearer", phone, password: "rider1234", role: "rider" },
    });
    expect(create.statusCode).toBe(200);
    const { user } = create.json() as { user: { id: string } };

    const membership = await harness.prisma.staffMembership.findFirst({ where: { userId: user.id } });
    expect(membership).toBeNull();
  });
});
