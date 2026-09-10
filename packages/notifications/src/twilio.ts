import type { NotificationProvider, OutboundMessage, SendResult } from "./core.js";
import { renderTemplate } from "./core.js";

export interface TwilioConfig {
  accountSid?: string;
  authToken?: string;
  /** e.g. whatsapp:+14155550000 */
  whatsappFrom?: string;
  /** e.g. +14155550000 */
  smsFrom?: string;
  /** allow overriding for tests */
  apiBase?: string;
}

/**
 * Twilio Programmable Messaging via raw REST (no SDK dependency).
 * Note: Meta requires business verification + approved templates for
 * business-initiated WhatsApp utility messages. The Twilio sandbox works
 * without approval for testing.
 */
export class TwilioProvider implements NotificationProvider {
  readonly name = "twilio";
  readonly channels = ["whatsapp", "sms"] as const;

  constructor(private readonly cfg: TwilioConfig) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.cfg.accountSid || !this.cfg.authToken) {
      return { status: "failed", error: "Twilio credentials not configured" };
    }
    const from = msg.channel === "whatsapp" ? this.cfg.whatsappFrom : this.cfg.smsFrom;
    if (!from) return { status: "failed", error: `No Twilio sender configured for ${msg.channel}` };
    const body = renderTemplate(msg.template, msg.params);
    const form = new URLSearchParams();
    form.set("From", from);
    form.set("To", msg.channel === "whatsapp" ? `whatsapp:${msg.to}` : msg.to);
    form.set("Body", body);
    try {
      const res = await fetch(
        `${this.cfg.apiBase ?? "https://api.twilio.com"}/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { status: "failed", error: `Twilio HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      const data = (await res.json()) as { sid?: string };
      return { status: "delivered", providerRef: data.sid ?? `twilio:${msg.refId}` };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
