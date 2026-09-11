import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CONVERSATION_KIND_LABELS, type ConversationKind, type ConversationSummaryDto, type ConversationsDto } from "@ronmacrae/contracts";

export interface ConversationTabsProps {
  /** unique per job/token — keys both the summary query and which tab is
   *  remembered as selected. */
  storageKey: string;
  fetchSummary: () => Promise<ConversationsDto>;
  /** Only the currently-selected tab's chat is ever mounted — two
   *  conversations polling simultaneously in the background, one of them
   *  never even visible, isn't worth the extra requests. `canWrite` is
   *  passed through so a caller with a viewer who can only ever monitor
   *  one specific conversation (staff on customer_rider) can render it
   *  read-only, even though the caller can write into its other tabs. */
  renderChat: (conversation: ConversationSummaryDto) => React.ReactNode;
  pollMs?: number;
}

/**
 * Tabbed switcher across a job's up-to-two conversations for one viewer
 * (Stage 24, spec 5) — e.g. a rider sees Customer/Dispatch, a customer
 * sees Dispatch/Rider, staff sees Customer/Rider(monitor-only)/Rider-
 * Dispatch. Shows an unread-count badge per tab from the conversations
 * summary endpoint, independent of which tab is currently open.
 */
export function ConversationTabs({ storageKey, fetchSummary, renderChat, pollMs = 20_000 }: ConversationTabsProps): React.JSX.Element {
  const summary = useQuery({
    queryKey: ["conversations", storageKey],
    queryFn: fetchSummary,
    refetchInterval: pollMs,
  });
  const conversations = summary.data?.conversations ?? [];
  const [selected, setSelected] = useState<ConversationKind | null>(null);
  const activeKind = selected && conversations.some((c) => c.kind === selected) ? selected : (conversations[0]?.kind ?? null);
  const active = conversations.find((c) => c.kind === activeKind) ?? null;

  if (summary.isLoading) return <p className="text-xs text-zinc-500">Loading conversations…</p>;
  if (conversations.length === 0) return <p className="text-xs text-zinc-500">No conversations available.</p>;

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5" role="tablist">
        {conversations.map((c) => (
          <button
            key={c.kind}
            type="button"
            role="tab"
            aria-selected={c.kind === activeKind}
            className={`relative rounded px-2.5 py-1 text-xs font-medium ${
              c.kind === activeKind ? "bg-brand-accent text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            }`}
            onClick={() => setSelected(c.kind)}
          >
            {CONVERSATION_KIND_LABELS[c.kind]}
            {!c.canWrite ? <span className="ml-1 opacity-70">(monitor)</span> : null}
            {c.unreadCount > 0 ? (
              <span className="ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                {c.unreadCount}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {active ? renderChat(active) : null}
    </div>
  );
}
