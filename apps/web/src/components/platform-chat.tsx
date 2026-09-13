import React, { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlatformMessagesDto } from "@ronmacrae/contracts";
import { ApiError } from "../lib/api.js";

const MAX_LENGTH = 1000;

export interface PlatformChatProps {
  /** unique key for this thread's query cache (e.g. `owner-${userId}` or `fleet-${riderId}`) */
  queryKey: string;
  fetchMessages: () => Promise<PlatformMessagesDto>;
  sendMessage: (body: string) => Promise<PlatformMessagesDto>;
  pollMs?: number;
  emptyLabel?: string;
}

/**
 * Shared chat UI for the non-job-scoped messaging threads (spec: "secure
 * messaging... admin-to-anyone, logistics<->riders") — a smaller sibling
 * of delivery-chat.tsx's DeliveryChat: no per-job "open"/closed gating, no
 * address-change proposal, no live-delivery receipt (these threads are
 * poll-only support/fleet chat, not delivery coordination), so it isn't
 * worth sharing that component's more elaborate props.
 */
export function PlatformChat({ queryKey, fetchMessages, sendMessage, pollMs = 15_000, emptyLabel = "No messages yet — say hello." }: PlatformChatProps): React.JSX.Element {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const conversation = useQuery({ queryKey: ["platform-chat", queryKey], queryFn: fetchMessages, refetchInterval: pollMs });
  const send = useMutation({
    mutationFn: (body: string) => sendMessage(body),
    onSuccess: (data) => qc.setQueryData(["platform-chat", queryKey], data),
  });

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [conversation.data?.messages.length]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    send.mutate(body);
  };

  return (
    <div className="space-y-2">
      <div ref={listRef} className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950/40 p-2">
        {conversation.isLoading ? <p className="text-xs text-zinc-500">Loading…</p> : null}
        {conversation.data && conversation.data.messages.length === 0 ? <p className="text-xs text-zinc-500">{emptyLabel}</p> : null}
        {conversation.data?.messages.map((m) => (
          <div key={m.id} className={`flex ${m.isSelf ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-lg px-2.5 py-1.5 text-sm ${m.isSelf ? "bg-brand text-white" : "bg-zinc-800 text-zinc-100"}`}>
              <p className="text-[10px] font-medium uppercase tracking-wide opacity-70">{m.senderName}</p>
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
              <p className="mt-0.5 text-[10px] opacity-60">
                {new Date(m.createdAt).toLocaleTimeString("en-JM", { hour: "numeric", minute: "2-digit" })}
                {m.isSelf ? ` · ${m.read ? "Read" : "Sent"}` : ""}
              </p>
            </div>
          </div>
        ))}
      </div>
      {conversation.error ? <p className="text-xs text-red-400">{conversation.error instanceof ApiError ? conversation.error.message : "Could not load messages."}</p> : null}
      <form onSubmit={submit} className="flex gap-2">
        <input className="input flex-1" value={draft} maxLength={MAX_LENGTH} onChange={(e) => setDraft(e.target.value)} placeholder="Type a message…" />
        <button className="btn-accent !px-3" type="submit" disabled={send.isPending || draft.trim() === ""}>
          {send.isPending ? "Sending…" : "Send"}
        </button>
      </form>
      {send.error ? <p className="text-xs text-red-400">{send.error instanceof ApiError ? send.error.message : "Could not send — try again."}</p> : null}
    </div>
  );
}
