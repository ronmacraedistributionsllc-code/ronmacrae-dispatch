import { describe, expect, it, vi } from "vitest";
import { MemoryProvider, renderTemplate, listTemplates, TwilioProvider, createNotificationProvider } from "../src/index.js";

describe("templates", () => {
  it("renders params and leaves unknown placeholders", () => {
    const out = renderTemplate("out_for_delivery", {
      customerName: "Shelly",
      riderName: "Kei",
      orderRef: "RM-123",
      eta: "3:40 PM",
      trackingUrl: "https://track.example/t/abc",
    });
    expect(out).toContain("Shelly");
    expect(out).toContain("Kei");
    expect(out).toContain("3:40 PM");
  });

  it("throws on unknown template", () => {
    expect(() => renderTemplate("nope", {})).toThrow();
    expect(listTemplates().map((t) => t.name)).toContain("order_confirmed");
  });
});

describe("MemoryProvider", () => {
  it("logs and marks delivered", async () => {
    const log = vi.fn();
    const p = new MemoryProvider(log);
    const res = await p.send({
      channel: "whatsapp",
      to: "+8765551234",
      template: "delivered",
      params: { orderRef: "RM-1", deliveredAt: "now", business: "Ronmacrae" },
      refId: "n1",
    });
    expect(res.status).toBe("delivered");
    expect(res.providerRef).toBe("memory:n1");
    expect(log).toHaveBeenCalledOnce();
  });
});

describe("TwilioProvider", () => {
  it("fails cleanly without credentials", async () => {
    const p = new TwilioProvider({ accountSid: "", authToken: "" });
    const res = await p.send({ channel: "sms", to: "+8765551234", template: "delivered", params: {} });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/credentials/);
  });

  it("posts to the messages endpoint with channel-prefixed To", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sid: "SM123" }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    const p = new TwilioProvider({
      accountSid: "ACtest",
      authToken: "token",
      whatsappFrom: "whatsapp:+14155550000",
      smsFrom: "+14155550000",
      apiBase: "https://api.example.test",
    });
    const res = await p.send({
      channel: "whatsapp",
      to: "+8765551234",
      template: "delivered",
      params: { orderRef: "X", deliveredAt: "y", business: "z" },
    });
    expect(res.status).toBe("delivered");
    expect(res.providerRef).toBe("SM123");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/2010-04-01/Accounts/ACtest/Messages.json");
    expect(String((init as { body: string }).body)).toContain("To=whatsapp%3A%2B8765551234");
    vi.unstubAllGlobals();
  });

  it("factory picks memory by default", () => {
    expect(createNotificationProvider({ provider: "memory" }).name).toBe("memory");
    expect(createNotificationProvider({ provider: "twilio", twilio: {} }).name).toBe("twilio");
  });
});
