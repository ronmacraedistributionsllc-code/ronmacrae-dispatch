/**
 * Minimal transactional-email sending (Stage 25, spec section 7) — email
 * verification and password-reset codes only, not the marketing/delivery-
 * status notification system (that's core.ts's own outbox+queue machinery,
 * a different shape of problem: async, retryable, templated, whatsapp/sms).
 * These are small, synchronous, immediate-feedback sends.
 *
 * Honest limitation: only a memory (dev-log) provider exists. No real SMTP/
 * SES/SendGrid/Postmark integration has been built or tested — doing so
 * needs real provider credentials this environment doesn't have, and
 * faking one would misrepresent what's actually been verified. A real
 * provider is a genuine, addable follow-up (implement `EmailProvider`,
 * same shape as `NotificationProvider` in core.ts) once credentials exist.
 */
export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  /** id of the sending row, used as provider reference */
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
 *  tests read back a code the same way a real inbox would have shown it. */
export class MemoryEmailProvider implements EmailProvider {
  readonly name = "memory";
  readonly sent: OutboundEmail[] = [];
  constructor(private readonly log: (line: string) => void = () => {}) {}

  async send(msg: OutboundEmail): Promise<EmailSendResult> {
    this.log(`[email] ${msg.to} <- ${msg.subject}: ${msg.text}` + (msg.refId ? ` [${msg.refId}]` : ""));
    this.sent.push(msg);
    if (this.sent.length > SENT_LOG_CAP) this.sent.shift();
    return { status: "sent", providerRef: `memory:${msg.refId ?? "email"}` };
  }
}

/** Only "memory" exists — see this file's own doc comment. The type is
 *  deliberately a single literal, not an open string, so it's structurally
 *  impossible to configure a provider that doesn't actually exist. */
export interface EmailConfig {
  provider: "memory";
  log?: (line: string) => void;
}

export function createEmailProvider(cfg: EmailConfig): EmailProvider {
  return new MemoryEmailProvider(cfg.log);
}
