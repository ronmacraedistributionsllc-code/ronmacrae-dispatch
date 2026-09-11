import React, { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeliveryMessagesDto } from "@ronmacrae/contracts";
import { ApiError } from "../lib/api.js";

const MAX_LENGTH = 1000;

export interface DeliveryChatProps {
  /** unique key for this conversation's query cache (e.g. `chat-${jobId}` or `chat-${token}`) */
  queryKey: string;
  fetchMessages: () => Promise<DeliveryMessagesDto>;
  /** `clientToken` is a fresh id generated per send attempt (see submit()
   *  below) — reused automatically across this mutation's own retries, so
   *  the server can recognize (and no-op) a retried send instead of
   *  creating a duplicate message. */
  sendMessage: (body: string, clientToken: string) => Promise<DeliveryMessagesDto>;
  quickReplies: string[];
  /** ms between polls — customer/rider/staff all poll as the baseline; staff/rider
   *  also get an immediate nudge from the realtime hub (see rider-dashboard.tsx /
   *  jobs.tsx), customer never does (no websocket for the public tracking page). */
  pollMs?: number;
  /** subscribes to something that should trigger an immediate refetch (e.g. the
   *  realtime "delivery_message" event) — returns an unsubscribe function, called
   *  once on mount. Omit for the customer view, which has no realtime channel. */
  onRealtimeNudge?: (refetch: () => void) => () => void;
  addressChange?: {
    onPropose: (proposedAddressText: string) => Promise<void>;
  };
  /** monitor-only viewer (e.g. accountant/viewer staff roles) — shows full
   *  history, never a way to send or propose anything. */
  readOnly?: boolean;
}

/**
 * Shared delivery-chat UI (spec 5G) — used by the customer tracking page,
 * the rider dashboard, and the dispatcher's Jobs screen, each supplying their
 * own fetch/send functions scoped correctly (tracking token, own job, any
 * job respectively) so this component itself never has to know which kind
 * of caller it's serving.
 */
export function DeliveryChat({ queryKey, fetchMessages, sendMessage, quickReplies, pollMs = 15_000, onRealtimeNudge, addressChange, readOnly }: DeliveryChatProps): React.JSX.Element {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [proposedAddress, setProposedAddress] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const conversation = useQuery({
    queryKey: ["delivery-chat", queryKey],
    queryFn: fetchMessages,
    refetchInterval: pollMs,
  });
  const send = useMutation({
    mutationFn: (vars: { body: string; clientToken: string }) => sendMessage(vars.body, vars.clientToken),
    onSuccess: (data) => qc.setQueryData(["delivery-chat", queryKey], data),
    // Retries reuse the same mutationFn call (so the same clientToken) —
    // a flaky send is retried, never silently duplicated on the server.
    retry: 2,
  });
  const proposeAddress = useMutation({
    mutationFn: (address: string) => addressChange!.onPropose(address),
    onSuccess: () => {
      setShowAddressForm(false);
      setProposedAddress("");
      void qc.invalidateQueries({ queryKey: ["delivery-chat", queryKey] });
    },
  });

  useEffect(() => {
    if (!onRealtimeNudge) return;
    return onRealtimeNudge(() => void qc.invalidateQueries({ queryKey: ["delivery-chat", queryKey] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [conversation.data?.messages.length]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    send.mutate({ body, clientToken: crypto.randomUUID() });
  };

  const open = conversation.data?.open ?? true;

  return (
    <div className="space-y-2">
      <div ref={listRef} className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950/40 p-2">
        {conversation.isLoading ? <p className="text-xs text-zinc-500">Loading conversation…</p> : null}
        {conversation.data && conversation.data.messages.length === 0 ? (
          <p className="text-xs text-zinc-500">No messages yet — say hello, or use a quick reply below.</p>
        ) : null}
        {conversation.data?.messages.map((m) => (
          <div key={m.id} className={`flex ${m.isSelf ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-lg px-2.5 py-1.5 text-sm ${m.isSelf ? "bg-brand text-white" : m.senderRole === "system" ? "bg-zinc-800/60 italic text-zinc-400" : "bg-zinc-800 text-zinc-100"}`}>
              {m.senderRole !== "system" ? <p className="text-[10px] font-medium uppercase tracking-wide opacity-70">{m.senderName}</p> : null}
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
              <p className="mt-0.5 text-[10px] opacity-60">
                {new Date(m.createdAt).toLocaleTimeString("en-JM", { hour: "numeric", minute: "2-digit" })}
                {m.isSelf ? ` · ${m.read ? "Read" : m.delivered ? "Delivered" : "Sent"}` : ""}
              </p>
            </div>
          </div>
        ))}
      </div>
      {conversation.error ? <p className="text-xs text-red-400">{conversation.error instanceof ApiError ? conversation.error.message : "Could not load the conversation — check your connection."}</p> : null}

      {readOnly ? (
        <p className="text-xs text-zinc-500">Monitor-only — you can read this conversation but not send to it.</p>
      ) : !open ? (
        <p className="text-xs text-zinc-500">
          {conversation.data ? `This conversation is closed (delivery ${conversation.data.jobStatus.replaceAll("_", " ")}).` : "This conversation is closed."} Message history stays visible above.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {quickReplies.map((q) => (
              <button key={q} type="button" className="btn !px-2 !py-0.5 text-xs" disabled={send.isPending} onClick={() => send.mutate({ body: q, clientToken: crypto.randomUUID() })}>
                {q}
              </button>
            ))}
            {addressChange ? (
              <button type="button" className="btn !px-2 !py-0.5 text-xs" onClick={() => setShowAddressForm((v) => !v)}>
                Request address change
              </button>
            ) : null}
          </div>
          {showAddressForm && addressChange ? (
            <div className="flex flex-wrap items-end gap-2 rounded border border-zinc-700 p-2">
              <div className="min-w-48 flex-1">
                <label className="label" htmlFor={`addr-${queryKey}`}>Proposed new address</label>
                <input id={`addr-${queryKey}`} className="input" value={proposedAddress} onChange={(e) => setProposedAddress(e.target.value)} placeholder="Type the exact new address" />
              </div>
              <button type="button" className="btn-accent !px-3 !py-1 text-xs" disabled={proposeAddress.isPending || proposedAddress.trim() === ""} onClick={() => proposeAddress.mutate(proposedAddress.trim())}>
                {proposeAddress.isPending ? "Sending…" : "Send request"}
              </button>
            </div>
          ) : null}
          {proposeAddress.error ? <p className="text-xs text-red-400">Could not send that request — try again.</p> : null}
          <p className="text-[11px] text-zinc-600">
            An address-change request is reviewed by dispatch before anything changes — it is never applied automatically.
          </p>
          <form onSubmit={submit} className="flex gap-2">
            <input
              className="input flex-1"
              value={draft}
              maxLength={MAX_LENGTH}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a message…"
            />
            <button className="btn-accent !px-3" type="submit" disabled={send.isPending || draft.trim() === ""}>
              {send.isPending ? "Sending…" : "Send"}
            </button>
          </form>
          {send.error ? <p className="text-xs text-red-400">{send.error instanceof ApiError ? send.error.message : "Could not send — try again."}</p> : null}
        </>
      )}
    </div>
  );
}
