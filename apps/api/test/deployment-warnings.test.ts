import { describe, expect, it } from "vitest";
import { deploymentWarnings } from "../src/lib/deployment-warnings.js";

describe("deploymentWarnings", () => {
  it("is silent for local dev, where memory providers are the point", () => {
    expect(deploymentWarnings({ devDb: true, emailProvider: "memory", notificationProvider: "memory" })).toEqual([]);
  });
  it("flags a real deployment whose email provider sends nothing", () => {
    const w = deploymentWarnings({ devDb: false, emailProvider: "memory", notificationProvider: "twilio" });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/EMAIL_PROVIDER/);
  });
  it("flags a real deployment whose SMS/WhatsApp provider sends nothing", () => {
    const w = deploymentWarnings({ devDb: false, emailProvider: "resend", notificationProvider: "memory" });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/NOTIFICATION_PROVIDER/);
  });
  it("flags both, and nothing when both are real", () => {
    expect(deploymentWarnings({ devDb: false, emailProvider: "memory", notificationProvider: "memory" })).toHaveLength(2);
    expect(deploymentWarnings({ devDb: false, emailProvider: "resend", notificationProvider: "twilio" })).toEqual([]);
  });
});
