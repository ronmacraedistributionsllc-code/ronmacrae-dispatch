/**
 * Transactional email sending. Two distinct callers share this same
 * abstraction:
 *   - Stage 25's small, synchronous verification/password-reset codes
 *     (text-only, immediate-feedback).
 *   - Merchant new-order notifications (Stage 30) — richer HTML+text email
 *     with an itemized order, sent server-side only (never from the
 *     browser — the frontend never sees an email provider key).
 *
 * Real provider: Resend (a plain HTTPS API, no SDK dependency) — set
 * RESEND_API_KEY + EMAIL_FROM and EMAIL_PROVIDER=resend to activate. No
 * live credentials exist in this environment, so this has never sent a
 * real email; the memory/dev-log provider is what every test and preview
 * actually exercises. See factory wiring in apps/api/src/config.ts.
 */
export interface OutboundEmail {
  /** One address, or several (e.g. a merchant with multiple notification recipients). */
  to: string | string[];
  subject: string;
  text: string;
  /** Optional rich body — a real provider sends this when present, falling
   *  back to `text` only; the memory provider logs both. */
  html?: string;
  /** id of the sending row/entity, used as provider reference and for logs. */
  refId?: string;
}

export interface EmailSendResult {
  status: "sent" | "failed";
  providerRef?: string;
  error?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: OutboundEmail): Promise<EmailSendResult>;
}

const SENT_LOG_CAP = 200;

/** Development/preview provider: logs and marks sent. Guarantees the full
 *  system runs with zero external credentials, same rationale as core.ts's
 *  MemoryProvider. Also keeps a small in-memory record of what it sent
 *  (`sent`, capped, never persisted) — there's no email-outbox table the
 *  way SMS/WhatsApp has core.ts's OutboxMessage, so this is what lets
 *  tests read back a code (or a merchant order email) the same way a real
 *  inbox would have shown it. */
export class MemoryEmailProvider implements EmailProvider {
  readonly name = "memory";
  readonly sent: OutboundEmail[] = [];
  constructor(private readonly log: (line: string) => void = () => {}) {}

  async send(msg: OutboundEmail): Promise<EmailSendResult> {
    const to = Array.isArray(msg.to) ? msg.to.join(", ") : msg.to;
    this.log(`[email] ${to} <- ${msg.subject}: ${msg.text}` + (msg.refId ? ` [${msg.refId}]` : ""));
    this.sent.push(msg);
    if (this.sent.length > SENT_LOG_CAP) this.sent.shift();
    return { status: "sent", providerRef: `memory:${msg.refId ?? "email"}` };
  }
}

export interface ResendConfig {
  apiKey?: string;
  /** e.g. "Ronmacrae Dispatch <orders@ronmacraedistributions.com>" — Resend
   *  requires a from-address on a domain you've verified with them. */
  from?: string;
  /** allow overriding for tests */
  apiBase?: string;
}

/**
 * Resend (https://resend.com) via raw REST — a single POST, no SDK. Chosen
 * over Postmark/SendGrid purely because its API is the smallest surface for
 * "send one transactional email"; swapping providers later means adding one
 * class implementing `EmailProvider`, same pattern as TwilioProvider.
 *
 * To actually activate this (not done here — no live credentials exist in
 * this environment):
 *   1. Create a Resend account, verify a sending domain.
 *   2. Set RESEND_API_KEY, EMAIL_FROM (must be on the verified domain), and
 *      EMAIL_PROVIDER=resend in the environment.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  constructor(private readonly cfg: ResendConfig) {}

  async send(msg: OutboundEmail): Promise<EmailSendResult> {
    if (!this.cfg.apiKey) return { status: "failed", error: "Resend API key not configured" };
    if (!this.cfg.from) return { status: "failed", error: "EMAIL_FROM not configured" };
    try {
      const res = await fetch(`${this.cfg.apiBase ?? "https://api.resend.com"}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.cfg.from,
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { status: "failed", error: `Resend HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      return { status: "sent", providerRef: data.id ?? `resend:${msg.refId ?? "email"}` };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export interface EmailConfig {
  provider: "memory" | "resend";
  resend?: ResendConfig;
  log?: (line: string) => void;
}

export function createEmailProvider(cfg: EmailConfig): EmailProvider {
  if (cfg.provider === "resend") return new ResendEmailProvider(cfg.resend ?? {});
  return new MemoryEmailProvider(cfg.log);
}
