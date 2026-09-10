import type { NotificationChannel } from "@ronmacrae/contracts";

export interface OutboundMessage {
  channel: Extract<NotificationChannel, "whatsapp" | "sms">;
  /** E.164 destination, e.g. +8765551234 */
  to: string;
  template: string;
  params: Record<string, string>;
  /** id of the outbox row, used as provider reference */
  refId?: string;
}

export interface SendResult {
  status: "delivered" | "failed";
  providerRef?: string;
  error?: string;
}

/**
 * Provider-agnostic messaging. The API persists every message to the outbox
 * and hands it to a provider; swapping Twilio for another vendor later means
 * adding one class.
 */
export interface NotificationProvider {
  readonly name: string;
  readonly channels: readonly ("whatsapp" | "sms")[];
  send(msg: OutboundMessage): Promise<SendResult>;
}

/** Static template registry. Text is rendered with {{param}} placeholders. */
export interface TemplateDef {
  name: string;
  /** WhatsApp-safe short text; links passed as params */
  body: string;
}

export const TEMPLATES: Record<string, TemplateDef> = {
  order_confirmed: {
    name: "order_confirmed",
    body:
      "Hi {{customerName}}, {{business}} confirms order {{orderRef}}. Track it here: {{trackingUrl}} (link expires in {{ttl}}).",
  },
  rider_assigned: {
    name: "rider_assigned",
    body:
      "Hi {{customerName}}, {{riderName}} has been assigned to delivery {{orderRef}}. Track it: {{trackingUrl}}",
  },
  picked_up: {
    name: "picked_up",
    body: "Update on order {{orderRef}}: your package has been picked up. Track: {{trackingUrl}}",
  },
  out_for_delivery: {
    name: "out_for_delivery",
    body:
      "Hi {{customerName}}, {{riderName}} is on the way with order {{orderRef}}. Estimated arrival {{eta}}. Track: {{trackingUrl}}",
  },
  delivered: {
    name: "delivered",
    body: "Order {{orderRef}} was delivered at {{deliveredAt}}. Thank you for shopping with {{business}}!",
  },
  failed: {
    name: "failed",
    body:
      "Hi {{customerName}}, we could not complete delivery {{orderRef}} ({{failureReason}}). {{business}} will reach out to reschedule.",
  },
  cod_reminder: {
    name: "cod_reminder",
    body:
      "Friendly reminder: order {{orderRef}} is {{amount}} cash on delivery. Have it ready for {{riderName}}.",
  },
  no_answer: {
    name: "no_answer",
    body:
      "Hi {{customerName}}, our courier could not reach you for delivery {{orderRef}} (no answer). Please call {{business}} on {{dispatchPhone}} to reschedule.",
  },
  location_changed: {
    name: "location_changed",
    body:
      "Hi {{customerName}}, we noted the new drop-off for delivery {{orderRef}}. {{riderName}} is heading there. Track: {{trackingUrl}}",
  },
  returned: {
    name: "returned",
    body:
      "Hi {{customerName}}, the package for {{orderRef}} has been returned to {{business}}. Contact us on {{dispatchPhone}} to arrange a new delivery.",
  },
  cancelled: {
    name: "cancelled",
    body:
      "Hi {{customerName}}, delivery {{orderRef}} was cancelled. If this is unexpected, contact {{business}} on {{dispatchPhone}}.",
  },
  requeued: {
    name: "requeued",
    body: "Hi {{customerName}}, we are trying again: delivery {{orderRef}} has been re-scheduled. Track: {{trackingUrl}}",
  },
};

export function renderTemplate(name: string, params: Record<string, string>): string {
  const tpl = TEMPLATES[name];
  if (!tpl) throw new Error(`Unknown notification template: ${name}`);
  return tpl.body.replace(/\{\{(\w+)\}\}/g, (m, key: string) => params[key] ?? m);
}

export function listTemplates(): { name: string; body: string }[] {
  return Object.values(TEMPLATES).map((t) => ({ name: t.name, body: t.body }));
}

/**
 * Development/preview provider: logs and marks delivered.
 * Guarantees the full system runs with zero external credentials.
 */
export class MemoryProvider implements NotificationProvider {
  readonly name = "memory";
  readonly channels = ["whatsapp", "sms"] as const;
  constructor(private readonly log: (line: string) => void = () => {}) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    const text = renderTemplate(msg.template, msg.params);
    this.log(
      `[notify:${msg.channel}] ${msg.to} <- (${msg.template}) ${text.replace(/\n/g, " ")}` +
        (msg.refId ? ` [${msg.refId}]` : ""),
    );
    return { status: "delivered", providerRef: `memory:${msg.refId ?? msg.template}` };
  }
}
