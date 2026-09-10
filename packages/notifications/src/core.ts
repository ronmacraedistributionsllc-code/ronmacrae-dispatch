import type { NotificationChannel } from "@ronmacrae/contracts";

export interface OutboundMessage {
  channel: Extract<NotificationChannel, "whatsapp" | "sms">;
  /** E.164 destination, e.g. +8765551234 */
  to: string;
  template: string;
  params: Record<string, string>;
  /** id of the outbox row, used as provider reference */
  refId?: string;
  /** admin-configured template-body overrides (Setting "notificationTemplates") */
  templateOverrides?: Record<string, string>;
}

export interface SendResult {
  /** "sent" = the provider accepted it for delivery — NOT confirmation it
   *  reached the recipient. Only use "delivered" when the provider has
   *  actually told us so (see the Twilio status callback). */
  status: "sent" | "delivered" | "failed";
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
  heading_to_pickup: {
    name: "heading_to_pickup",
    body:
      "Hi {{customerName}}, {{riderName}} is heading to collect order {{orderRef}} now. Track it: {{trackingUrl}}",
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
  near_destination: {
    name: "near_destination",
    body:
      "Hi {{customerName}}, {{riderName}} is close by with order {{orderRef}} — please have someone ready to receive it. Track: {{trackingUrl}}",
  },
  delivered: {
    name: "delivered",
    body: "Order {{orderRef}} was delivered at {{deliveredAt}}. Thank you for shopping with {{business}}!",
  },
  failed: {
    name: "failed",
    body:
      "Hi {{customerName}}, we could not complete delivery {{orderRef}} ({{failureReason}}). {{business}} will reach out to reschedule. Track: {{trackingUrl}}",
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

/** Effective body for a template name: an admin-configured override (see the
 *  Setting key "notificationTemplates" in apps/api/src/modules/notify.ts)
 *  wins over the built-in default; falls back to the default when there's no
 *  override or the override is blank. */
export function effectiveTemplateBody(name: string, overrides?: Record<string, string>): string {
  const override = overrides?.[name]?.trim();
  if (override) return override;
  const tpl = TEMPLATES[name];
  if (!tpl) throw new Error(`Unknown notification template: ${name}`);
  return tpl.body;
}

export function renderTemplate(name: string, params: Record<string, string>, overrides?: Record<string, string>): string {
  const body = effectiveTemplateBody(name, overrides);
  return body.replace(/\{\{(\w+)\}\}/g, (m, key: string) => params[key] ?? m);
}

export function listTemplates(overrides?: Record<string, string>): { name: string; defaultBody: string; body: string; overridden: boolean }[] {
  return Object.values(TEMPLATES).map((t) => {
    const override = overrides?.[t.name]?.trim();
    return { name: t.name, defaultBody: t.body, body: override || t.body, overridden: Boolean(override) };
  });
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
    const text = renderTemplate(msg.template, msg.params, msg.templateOverrides);
    this.log(
      `[notify:${msg.channel}] ${msg.to} <- (${msg.template}) ${text.replace(/\n/g, " ")}` +
        (msg.refId ? ` [${msg.refId}]` : ""),
    );
    return { status: "delivered", providerRef: `memory:${msg.refId ?? msg.template}` };
  }
}
