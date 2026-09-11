import React from "react";
import { useQuery } from "@tanstack/react-query";
import { API } from "@ronmacrae/contracts";
import type { DispatchContactDto } from "@ronmacrae/contracts";
import { apiFetch } from "../lib/api.js";

/** wa.me needs digits only (no +, spaces, or dashes). */
function whatsAppDigits(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

/**
 * "Contact dispatch" — an easy-to-reach Call/Message action on every active
 * job (spec 5F), using only the owner-configured dispatch phone/WhatsApp
 * (never an individual staff member's own number). The job reference is
 * included in the prefilled message text where the channel supports it
 * (SMS/WhatsApp) — a phone call can't carry text, so the label itself names
 * the job instead.
 */
export function ContactDispatch({ jobId, jobLabel }: { jobId: string; jobLabel: string }): React.JSX.Element | null {
  const contact = useQuery({
    // A rider can carry jobs for several businesses — the dispatch contact
    // is per-business, so it's keyed (and fetched) per job, never shared.
    queryKey: ["dispatch-contact", jobId],
    queryFn: () => apiFetch<DispatchContactDto>(API.bearer.dispatchContact(jobId)),
    staleTime: 5 * 60_000,
  });

  if (contact.isLoading) return null;
  if (!contact.data || (!contact.data.dispatchPhone && !contact.data.dispatchWhatsApp)) {
    return <p className="text-xs text-zinc-600">Dispatch contact number not configured yet.</p>;
  }

  const { dispatchPhone, dispatchWhatsApp } = contact.data;
  const messageText = encodeURIComponent(`Hi, I need help with delivery ${jobLabel}.`);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-zinc-500">Contact dispatch about {jobLabel}:</span>
      {dispatchPhone ? (
        <>
          <a className="btn !px-2 !py-0.5 text-xs" href={`tel:${dispatchPhone}`}>Call</a>
          <a className="btn !px-2 !py-0.5 text-xs" href={`sms:${dispatchPhone}?body=${messageText}`}>Message</a>
        </>
      ) : null}
      {dispatchWhatsApp ? (
        <a className="btn !px-2 !py-0.5 text-xs" href={`https://wa.me/${whatsAppDigits(dispatchWhatsApp)}?text=${messageText}`} target="_blank" rel="noreferrer">
          WhatsApp
        </a>
      ) : null}
    </div>
  );
}
