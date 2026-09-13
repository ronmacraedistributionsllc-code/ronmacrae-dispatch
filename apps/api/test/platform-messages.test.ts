/**
 * Non-job-scoped direct messaging (spec: "secure messaging with a strict
 * authorization matrix... admin-to-anyone, logistics<->riders"), Stage 37.
 * Two independent thread shapes — see platform-messages.ts's own doc
 * comment — each covered here for both directions plus isolation from an
 * unrelated third party.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function ownerToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Owner ${uniq()}`, passwordHash: "unused-in-tests", role: "admin", platformRole: "owner" } });
  return { id: user.id, token: await h.tokenFor({ id: user.id, name: user.name, role: "admin", platformRole: "owner" }) };
}

async function staffUser(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Dispatcher ${uniq()}`, passwordHash: "unused-in-tests", role: "dispatcher" } });
  return { id: user.id, token: await h.tokenFor({ id: user.id, name: user.name, role: "dispatcher", businessId: h.business.id }) };
}

async function adminToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Admin ${uniq()}`, passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", businessId: h.business.id });
}

async function makeCompany(h: TestHarness, auth: string) {
  const res = await h.app.inject({ method: "POST", url: "/api/logistics-companies", headers: { authorization: `Bearer ${auth}` }, payload: { name: `Fleet ${uniq()}` } });
  return (res.json() as { logisticsCompany: { id: string } }).logisticsCompany;
}

async function logisticsPortalToken(h: TestHarness, admin: string, companyId: string) {
  const email = `fleet-${uniq()}@example.com`;
  await h.app.inject({ method: "POST", url: `/api/logistics-companies/${companyId}/staff`, headers: { authorization: `Bearer ${admin}` }, payload: { email, password: "fleetpass1" } });
  const login = await h.app.inject({ method: "POST", url: "/api/logistics-portal/login", payload: { email, password: "fleetpass1" } });
  return (login.json() as { token: string }).token;
}

async function makeRider(h: TestHarness, auth: string) {
  const res = await h.app.inject({ method: "POST", url: "/api/riders", headers: { authorization: `Bearer ${auth}` }, payload: { name: `Rider ${uniq()}`, phone: `+1876558${uniq().slice(-4)}` } });
  return (res.json() as { rider: { id: string } }).rider;
}

beforeAll(async () => {
  harness = await buildTestHarness("test-platform-messages");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("owner <-> user messaging", () => {
  it("a staff user messages the owner, the owner sees it in the inbox and replies, and the user sees the reply", async () => {
    const owner = await ownerToken(harness);
    const staff = await staffUser(harness);

    const send = await harness.app.inject({ method: "POST", url: "/api/messages/owner", headers: { authorization: `Bearer ${staff.token}` }, payload: { body: "Need help with a payout" } });
    expect(send.statusCode).toBe(200);
    const sent = send.json() as { messages: { isSelf: boolean; body: string }[] };
    expect(sent.messages.at(-1)?.isSelf).toBe(true);
    expect(sent.messages.at(-1)?.body).toBe("Need help with a payout");

    const threads = await harness.app.inject({ method: "GET", url: "/api/platform/messages", headers: { authorization: `Bearer ${owner.token}` } });
    expect(threads.statusCode).toBe(200);
    const { threads: list } = threads.json() as { threads: { userId: string; unreadCount: number }[] };
    const thread = list.find((t) => t.userId === staff.id);
    expect(thread?.unreadCount).toBe(1);

    const reply = await harness.app.inject({ method: "POST", url: `/api/platform/messages/${staff.id}`, headers: { authorization: `Bearer ${owner.token}` }, payload: { body: "On it — checking now" } });
    expect(reply.statusCode).toBe(200);

    const userSide = await harness.app.inject({ method: "GET", url: "/api/messages/owner", headers: { authorization: `Bearer ${staff.token}` } });
    const body = userSide.json() as { messages: { body: string; senderRole: string; isSelf: boolean }[] };
    expect(body.messages.map((m) => m.body)).toEqual(["Need help with a payout", "On it — checking now"]);
    expect(body.messages[1]?.senderRole).toBe("owner");
    expect(body.messages[1]?.isSelf).toBe(false);

    // The owner's own unread count for this thread clears after reading it.
    const threadsAfter = await harness.app.inject({ method: "GET", url: "/api/platform/messages", headers: { authorization: `Bearer ${owner.token}` } });
    const threadAfter = (threadsAfter.json() as { threads: { userId: string; unreadCount: number }[] }).threads.find((t) => t.userId === staff.id);
    expect(threadAfter?.unreadCount).toBe(0);
  });

  it("never shows one user's thread to another, and a non-owner is refused entirely", async () => {
    const owner = await ownerToken(harness);
    const staffA = await staffUser(harness);
    const staffB = await staffUser(harness);

    await harness.app.inject({ method: "POST", url: "/api/messages/owner", headers: { authorization: `Bearer ${staffA.token}` }, payload: { body: "A's private message" } });

    const asOwner = await harness.app.inject({ method: "GET", url: `/api/platform/messages/${staffA.id}`, headers: { authorization: `Bearer ${owner.token}` } });
    expect((asOwner.json() as { messages: { body: string }[] }).messages.some((m) => m.body === "A's private message")).toBe(true);

    const bsInbox = await harness.app.inject({ method: "GET", url: "/api/messages/owner", headers: { authorization: `Bearer ${staffB.token}` } });
    expect((bsInbox.json() as { messages: unknown[] }).messages).toEqual([]);

    const nonOwnerAttempt = await harness.app.inject({ method: "GET", url: `/api/platform/messages/${staffA.id}`, headers: { authorization: `Bearer ${staffB.token}` } });
    expect(nonOwnerAttempt.statusCode).toBe(403);
  });

  it("a merchant-portal and a logistics-portal account can also message the owner through their own face", async () => {
    const owner = await ownerToken(harness);
    const admin = await adminToken(harness);

    const merchantEmail = `merchant-msg-${uniq()}@example.com`;
    const merchant = await harness.app.inject({ method: "POST", url: "/api/merchants", headers: { authorization: `Bearer ${admin}` }, payload: { name: `M ${uniq()}` } });
    const merchantId = (merchant.json() as { merchant: { id: string } }).merchant.id;
    await harness.app.inject({ method: "POST", url: `/api/merchants/${merchantId}/staff`, headers: { authorization: `Bearer ${admin}` }, payload: { email: merchantEmail, password: "merchantpass1" } });
    const merchantLogin = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/login", payload: { email: merchantEmail, password: "merchantpass1" } });
    const merchantToken = (merchantLogin.json() as { token: string }).token;

    const sendFromMerchant = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/messages/owner", headers: { authorization: `Bearer ${merchantToken}` }, payload: { body: "Question about settlement" } });
    expect(sendFromMerchant.statusCode).toBe(200);

    const company = await makeCompany(harness, admin);
    const logisticsToken = await logisticsPortalToken(harness, admin, company.id);
    const sendFromLogistics = await harness.app.inject({ method: "POST", url: "/api/logistics-portal/messages/owner", headers: { authorization: `Bearer ${logisticsToken}` }, payload: { body: "Question about our contract" } });
    expect(sendFromLogistics.statusCode).toBe(200);

    const threads = await harness.app.inject({ method: "GET", url: "/api/platform/messages", headers: { authorization: `Bearer ${owner.token}` } });
    const bodies = (threads.json() as { threads: { lastMessage: { body: string } | null }[] }).threads.map((t) => t.lastMessage?.body);
    expect(bodies).toContain("Question about settlement");
    expect(bodies).toContain("Question about our contract");
  });
});

describe("logistics <-> rider fleet messaging", () => {
  it("a company messages its own attached rider, and the rider sees and replies to it from the bearer face", async () => {
    const admin = await adminToken(harness);
    const company = await makeCompany(harness, admin);
    const logisticsToken = await logisticsPortalToken(harness, admin, company.id);
    const rider = await makeRider(harness, admin);
    const owner = await ownerToken(harness);
    await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner.token}` }, payload: { attachment: "logistics", attachedLogisticsCompanyId: company.id } });
    const riderUser = await harness.prisma.user.create({ data: { name: "Fleet Rider", passwordHash: "unused-in-tests", role: "rider" } });
    const riderToken = await harness.tokenFor({ id: riderUser.id, name: riderUser.name, role: "rider", riderId: rider.id });

    const send = await harness.app.inject({ method: "POST", url: `/api/logistics-portal/riders/${rider.id}/messages`, headers: { authorization: `Bearer ${logisticsToken}` }, payload: { body: "Please head to the Kingston depot" } });
    expect(send.statusCode).toBe(200);

    const riderInbox = await harness.app.inject({ method: "GET", url: "/api/bearer/logistics-messages", headers: { authorization: `Bearer ${riderToken}` } });
    expect(riderInbox.statusCode).toBe(200);
    const inboxBody = riderInbox.json() as { messages: { body: string; senderRole: string }[] };
    expect(inboxBody.messages.at(-1)?.body).toBe("Please head to the Kingston depot");
    expect(inboxBody.messages.at(-1)?.senderRole).toBe("logistics");

    const reply = await harness.app.inject({ method: "POST", url: "/api/bearer/logistics-messages", headers: { authorization: `Bearer ${riderToken}` }, payload: { body: "On my way" } });
    expect(reply.statusCode).toBe(200);

    const companySide = await harness.app.inject({ method: "GET", url: `/api/logistics-portal/riders/${rider.id}/messages`, headers: { authorization: `Bearer ${logisticsToken}` } });
    const companyBody = companySide.json() as { messages: { body: string; senderRole: string }[] };
    expect(companyBody.messages.map((m) => m.body)).toEqual(["Please head to the Kingston depot", "On my way"]);
  });

  it("refuses a rider not attached to that company, and a rider with no attachment at all gets a clear 404", async () => {
    const admin = await adminToken(harness);
    const companyA = await makeCompany(harness, admin);
    const companyB = await makeCompany(harness, admin);
    const logisticsTokenA = await logisticsPortalToken(harness, admin, companyA.id);
    const riderInB = await makeRider(harness, admin);
    const owner = await ownerToken(harness);
    await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${riderInB.id}`, headers: { authorization: `Bearer ${owner.token}` }, payload: { attachment: "logistics", attachedLogisticsCompanyId: companyB.id } });

    // Company A can never reach company B's rider.
    const crossAttempt = await harness.app.inject({ method: "GET", url: `/api/logistics-portal/riders/${riderInB.id}/messages`, headers: { authorization: `Bearer ${logisticsTokenA}` } });
    expect(crossAttempt.statusCode).toBe(404);

    // A freelance rider (no attachment at all) has nothing to message.
    const freelanceRider = await makeRider(harness, admin);
    const freelanceUser = await harness.prisma.user.create({ data: { name: "Freelance Rider", passwordHash: "unused-in-tests", role: "rider" } });
    const freelanceToken = await harness.tokenFor({ id: freelanceUser.id, name: freelanceUser.name, role: "rider", riderId: freelanceRider.id });
    const noCompany = await harness.app.inject({ method: "GET", url: "/api/bearer/logistics-messages", headers: { authorization: `Bearer ${freelanceToken}` } });
    expect(noCompany.statusCode).toBe(404);
  });
});
