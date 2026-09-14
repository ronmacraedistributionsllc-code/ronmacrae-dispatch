import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ACTIVE_JOB_STATUSES, API, JOB_SOURCES, JOB_STATUSES, RIDER_STAGE_LABELS, allowedTransitions } from "@ronmacrae/contracts";
import type { AddressChangeRequestDto, ConversationsDto, DeliveryMessagesDto, JobSource, JobStatus, JobSummaryDto, MerchantDto, RiderDto } from "@ronmacrae/contracts";
import { ApiError, apiFetch, formatMoney } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { JobOffersPanel } from "../components/job-offers-panel.js";
import { ReadOnlyRiderQueue } from "../components/route-queue.js";
import { DeliveryChat } from "../components/delivery-chat.js";
import { ConversationTabs } from "../components/conversation-tabs.js";
import { useRealtime } from "../lib/realtime.js";

const STATUS_BADGE: Record<JobStatus, string> = {
  new: "bg-zinc-800 text-zinc-300",
  assigned: "bg-sky-900/50 text-sky-300",
  accepted: "bg-sky-900/50 text-sky-300",
  picked_up: "bg-indigo-900/50 text-indigo-300",
  in_transit: "bg-indigo-900/50 text-indigo-300",
  delivering: "bg-violet-900/50 text-violet-300",
  delivered: "bg-emerald-900/50 text-emerald-300",
  no_answer: "bg-amber-900/50 text-amber-300",
  location_changed: "bg-amber-900/50 text-amber-300",
  failed: "bg-red-900/50 text-red-300",
  returned: "bg-violet-900/50 text-violet-300",
  cancelled: "bg-zinc-800 text-zinc-500",
};

/** Transition options minus the ones covered by the dedicated assign/unassign buttons. */
function moveOptions(status: JobStatus): JobStatus[] {
  return allowedTransitions(status).filter((to) => to !== "assigned" && to !== "new");
}

interface RowProps {
  job: JobSummaryDto;
  riders: RiderDto[];
  canWrite: boolean;
  busy: boolean;
  offersOpen: boolean;
  queueOpen: boolean;
  chatOpen: boolean;
  onAssign: (jobId: string, riderId: string) => void;
  onUnassign: (jobId: string) => void;
  onMove: (jobId: string, to: JobStatus) => void;
  onToggleOffers: (jobId: string) => void;
  onToggleQueue: () => void;
  onToggleChat: () => void;
  onDelete: (jobId: string, reason: string | null) => void;
}

function JobRow({ job, riders, canWrite, busy, offersOpen, queueOpen, chatOpen, onAssign, onUnassign, onMove, onToggleOffers, onToggleQueue, onToggleChat, onDelete }: RowProps): React.JSX.Element {
  const [riderId, setRiderId] = useState(job.riderId ?? "");
  const [moveTo, setMoveTo] = useState<JobStatus | "">("");
  const assignable = job.status === "new" || job.status === "assigned";
  const unassignable = job.status === "assigned" || job.status === "accepted";
  const moves = moveOptions(job.status);
  // Mirrors the backend's own rule (jobs/trash.ts's assertDeletable) — only
  // offer the button when it would actually succeed, rather than showing
  // it everywhere and surfacing a 409 on click.
  const deletable = !ACTIVE_JOB_STATUSES.includes(job.status);

  return (
    <tr className={`border-t align-top ${job.priority === "urgent" ? "border-red-900/40 bg-red-950/20" : "border-zinc-800"}`}>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-zinc-200">{job.jobNumber ?? job.id.slice(0, 8)}</span>
          {job.priority === "urgent" ? (
            <span className="rounded bg-red-900/70 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-200">Urgent</span>
          ) : null}
        </div>
        <div className="text-xs text-zinc-500">
          {job.merchantName ? <span className="mr-1 rounded bg-zinc-800 px-1 py-0.5 text-zinc-300">{job.merchantName}</span> : null}
          {job.source} · {job.type}
        </div>
        {job.itemSummary ? (
          <div className="max-w-40 truncate text-xs text-zinc-500" title={job.itemSummary}>
            {job.itemSummary}
          </div>
        ) : null}
      </td>
      <td className="py-2 pr-3">
        <div className="text-zinc-200">{job.customerName}</div>
        <div className="text-xs text-zinc-500">{job.customerPhone}</div>
      </td>
      <td className="max-w-44 py-2 pr-3">
        <div className="truncate text-zinc-300" title={job.addressText ?? undefined}>
          {job.addressText ?? "–"}
        </div>
        {job.zoneName ? <div className="text-xs text-zinc-500">{job.zoneName}</div> : null}
      </td>
      <td className="py-2 pr-3">
        <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[job.status]}`}>
          {job.status}
        </span>
      </td>
      <td className="whitespace-nowrap py-2 pr-3 text-xs text-zinc-400">{RIDER_STAGE_LABELS[job.stage]}</td>
      <td className="whitespace-nowrap py-2 pr-3">
        <div>{formatMoney(job.amountExpected)}</div>
        <div className="text-xs text-zinc-500">{job.paymentStatus}</div>
      </td>
      <td className="whitespace-nowrap py-2 pr-3 text-zinc-300">{job.riderName ?? "—"}</td>
      {canWrite ? (
        <td className="py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {assignable ? (
              <>
                <select
                  className="input w-40 !py-1"
                  value={riderId}
                  disabled={busy}
                  onChange={(e) => setRiderId(e.target.value)}
                >
                  <option value="">Courier…</option>
                  {riders.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} · {r.status}
                    </option>
                  ))}
                </select>
                <button
                  className="btn !px-3 !py-1 text-xs"
                  disabled={busy || riderId === ""}
                  onClick={() => onAssign(job.id, riderId)}
                >
                  {job.riderId ? "Reassign" : "Assign"}
                </button>
              </>
            ) : null}
            {unassignable ? (
              <button className="btn !px-3 !py-1 text-xs" disabled={busy} onClick={() => onUnassign(job.id)}>
                Unassign
              </button>
            ) : null}
            {moves.length > 0 ? (
              <>
                <select
                  className="input w-36 !py-1"
                  value={moveTo}
                  disabled={busy}
                  onChange={(e) => setMoveTo(e.target.value as JobStatus | "")}
                >
                  <option value="">Move to…</option>
                  {moves.map((to) => (
                    <option key={to} value={to}>
                      {to}
                    </option>
                  ))}
                </select>
                <button
                  className="btn !px-3 !py-1 text-xs"
                  disabled={busy || moveTo === ""}
                  onClick={() => {
                    onMove(job.id, moveTo as JobStatus);
                    setMoveTo("");
                  }}
                >
                  Move
                </button>
              </>
            ) : null}
            {!assignable && !unassignable && moves.length === 0 ? (
              <span className="text-xs text-zinc-600">closed</span>
            ) : null}
            {job.status === "new" ? (
              <button className="btn !px-3 !py-1 text-xs" disabled={busy} onClick={() => onToggleOffers(job.id)}>
                {offersOpen ? "Hide offers" : "Offers"}
              </button>
            ) : null}
            {job.riderId ? (
              <button className="btn !px-3 !py-1 text-xs" disabled={busy} onClick={() => onToggleQueue()}>
                {queueOpen ? "Hide route queue" : "Route queue"}
              </button>
            ) : null}
            <button className="btn !px-3 !py-1 text-xs" disabled={busy} onClick={() => onToggleChat()}>
              {chatOpen ? "Hide messages" : "Messages"}
            </button>
            {deletable ? (
              <button
                className="btn !px-3 !py-1 text-xs text-red-300 hover:!bg-red-950/40"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Delete order ${job.jobNumber ?? job.id.slice(0, 8)}? It moves to Trash and can be restored within 30 days.`)) return;
                  const reason = window.prompt("Reason (optional):") ?? "";
                  onDelete(job.id, reason.trim() || null);
                }}
              >
                Delete
              </button>
            ) : null}
          </div>
        </td>
      ) : null}
    </tr>
  );
}


export function Jobs(): React.JSX.Element {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canWrite = user?.role === "admin" || user?.role === "dispatcher";
  const [offersJobId, setOffersJobId] = useState<string | null>(null);
  const [queueJobId, setQueueJobId] = useState<string | null>(null);
  const [chatJobId, setChatJobId] = useState<string | null>(null);

  const [status, setStatus] = useState<JobStatus | "">("");
  const [source, setSource] = useState<JobSource | "">("");
  const [merchantId, setMerchantId] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const merchants = useQuery({ queryKey: ["merchants"], queryFn: () => apiFetch<{ merchants: MerchantDto[] }>(API.merchants.list) });

  const jobs = useQuery({
    queryKey: ["jobs", status, source, merchantId, search],
    queryFn: () => {
      const p = new URLSearchParams({ take: "100" });
      if (status) p.set("status", status);
      if (source) p.set("source", source);
      if (merchantId) p.set("merchantId", merchantId);
      if (search) p.set("search", search);
      return apiFetch<{ jobs: JobSummaryDto[]; total: number }>(`/jobs?${p.toString()}`);
    },
    refetchInterval: 15_000,
  });

  const riders = useQuery({
    queryKey: ["riders"],
    queryFn: () => apiFetch<{ riders: RiderDto[] }>("/riders"),
    enabled: canWrite,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["jobs"] });
    void qc.invalidateQueries({ queryKey: ["riders"] });
  };

  const assign = useMutation({
    mutationFn: ({ jobId, riderId }: { jobId: string; riderId: string }) =>
      apiFetch(`/jobs/${jobId}/assignments`, { method: "POST", body: JSON.stringify({ riderId }) }),
    onSettled: invalidate,
  });
  const unassign = useMutation({
    mutationFn: (jobId: string) =>
      apiFetch(`/jobs/${jobId}/assignments`, { method: "DELETE", body: JSON.stringify({}) }),
    onSettled: invalidate,
  });
  const move = useMutation({
    mutationFn: ({ jobId, to }: { jobId: string; to: JobStatus }) =>
      apiFetch(`/jobs/${jobId}/transition`, { method: "POST", body: JSON.stringify({ to }) }),
    onSettled: invalidate,
  });
  const deleteJob = useMutation({
    mutationFn: ({ jobId, reason }: { jobId: string; reason: string | null }) =>
      apiFetch(API.jobs.delete(jobId), { method: "POST", body: JSON.stringify({ reason }) }),
    onSettled: invalidate,
  });

  const busy = assign.isPending || unassign.isPending || move.isPending || deleteJob.isPending;
  const error = assign.error ?? unassign.error ?? move.error ?? deleteJob.error;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Jobs</h1>
          <p className="text-sm text-zinc-400">Dispatch queue — assign couriers, move jobs, keep track of cash</p>
        </div>
        {canWrite ? null : (
          <span className="rounded px-2 py-0.5 text-xs font-medium bg-zinc-800 text-zinc-400">read-only</span>
        )}
      </header>

      <section className="card">
        <div className="grid gap-3 md:grid-cols-5">
          <div>
            <label className="label" htmlFor="job-status">
              Status
            </label>
            <select
              id="job-status"
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as JobStatus | "")}
            >
              <option value="">All statuses</option>
              {JOB_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="job-source">
              Source
            </label>
            <select
              id="job-source"
              className="input"
              value={source}
              onChange={(e) => setSource(e.target.value as JobSource | "")}
            >
              <option value="">All sources</option>
              {JOB_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="job-merchant">
              Merchant
            </label>
            <select id="job-merchant" className="input" value={merchantId} onChange={(e) => setMerchantId(e.target.value)}>
              <option value="">All merchants</option>
              {merchants.data?.merchants.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor="job-search">
              Search
            </label>
            <input
              id="job-search"
              className="input"
              placeholder="Job number, customer, phone or address"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
        </div>
      </section>

      <section className="card">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Dispatch queue</h2>
          <span className="text-xs text-zinc-500">
            {jobs.data ? `${jobs.data.jobs.length} of ${jobs.data.total} jobs` : "loading…"}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-1 pr-3">Job</th>
                <th className="py-1 pr-3">Customer</th>
                <th className="py-1 pr-3">Location</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Stage</th>
                <th className="py-1 pr-3">Expected</th>
                <th className="py-1 pr-3">Courier</th>
                {canWrite ? <th className="py-1">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {jobs.data?.jobs.map((job) => (
                <React.Fragment key={job.id}>
                  <JobRow
                    job={job}
                    riders={riders.data?.riders ?? []}
                    canWrite={canWrite}
                    busy={busy}
                    offersOpen={offersJobId === job.id}
                    queueOpen={queueJobId === job.id}
                    chatOpen={chatJobId === job.id}
                    onAssign={(id, rid) => void assign.mutate({ jobId: id, riderId: rid })}
                    onUnassign={(id) => void unassign.mutate(id)}
                    onMove={(id, to) => void move.mutate({ jobId: id, to })}
                    onToggleOffers={(id) => setOffersJobId((cur) => (cur === id ? null : id))}
                    onToggleQueue={() => setQueueJobId((cur) => (cur === job.id ? null : job.id))}
                    onToggleChat={() => setChatJobId((cur) => (cur === job.id ? null : job.id))}
                    onDelete={(id, reason) => void deleteJob.mutate({ jobId: id, reason })}
                  />
                  {offersJobId === job.id ? (
                    <tr className="border-t border-zinc-800" data-testid={`offers-panel-${job.id}`}>
                      <td colSpan={canWrite ? 8 : 7} className="py-2">
                        <JobOffersPanel jobId={job.id} jobStatus={job.status} canWrite={canWrite} />
                      </td>
                    </tr>
                  ) : null}
                  {job.riderId && queueJobId === job.id ? (
                    <tr className="border-t border-zinc-800" data-testid={`queue-panel-${job.riderId}`}>
                      <td colSpan={canWrite ? 8 : 7} className="py-2">
                        <ReadOnlyRiderQueue riderId={job.riderId} />
                      </td>
                    </tr>
                  ) : null}
                  {chatJobId === job.id ? (
                    <tr className="border-t border-zinc-800" data-testid={`chat-panel-${job.id}`}>
                      <td colSpan={canWrite ? 8 : 7} className="py-2">
                        <DispatcherJobChat jobId={job.id} canWrite={canWrite} />
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {jobs.isLoading ? (
          <p className="mt-2 text-sm text-zinc-500">Loading jobs…</p>
        ) : jobs.data && jobs.data.jobs.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No jobs match the filters.</p>
        ) : null}
        {error ? (
          <p className="mt-2 text-sm text-red-400">{error instanceof ApiError ? error.message : "Request failed"}</p>
        ) : null}
      </section>
    </div>
  );
}

/** Dispatcher/owner view of one job's conversation (spec 5G) — monitor for
 *  every staff role that can see the Jobs screen; respond, and approve/
 *  decline address-change requests, for admin/dispatcher only. */
function DispatcherJobChat({ jobId, canWrite }: { jobId: string; canWrite: boolean }): React.JSX.Element {
  const qc = useQueryClient();
  const { subscribe } = useRealtime();
  const requests = useQuery({
    queryKey: ["address-change-requests", jobId],
    queryFn: () => apiFetch<{ requests: AddressChangeRequestDto[] }>(API.messages.addressChangeRequests(jobId)),
    refetchInterval: 15_000,
  });
  const decide = useMutation({
    mutationFn: ({ reqId, decision, note }: { reqId: string; decision: "approve" | "decline"; note?: string }) =>
      apiFetch(decision === "approve" ? API.messages.approveAddressChange(jobId, reqId) : API.messages.declineAddressChange(jobId, reqId), {
        method: "POST",
        body: JSON.stringify(decision === "decline" ? { note } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["address-change-requests", jobId] });
      void qc.invalidateQueries({ queryKey: ["conversations", `staff-${jobId}`] });
      // An address-change decision fans out as a system message into
      // whichever of this job's conversations it's relevant to (see
      // sendSystemMessage in delivery-messages.ts) — every "staff-<job>-*"
      // conversation query needs a refetch, not just one fixed key, since
      // each conversation now has its own query key suffixed by kind.
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "delivery-chat" && String(q.queryKey[1]).startsWith(`staff-${jobId}-`) });
    },
  });
  const pending = (requests.data?.requests ?? []).filter((r) => r.status === "pending");

  return (
    <div className="space-y-3">
      {pending.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-amber-800/50 bg-amber-950/10 p-3">
          <p className="text-sm font-medium text-amber-200">Address change requested — review before it takes effect</p>
          {pending.map((r) => (
            <div key={r.id} className="rounded bg-zinc-900/40 p-2 text-sm">
              <p className="text-zinc-200">
                {r.requestedByRole === "customer" ? "Customer" : "Courier"} proposed: <span className="font-medium">{r.proposedAddressText}</span>
              </p>
              {r.note ? <p className="text-xs text-zinc-500">Note: {r.note}</p> : null}
              {canWrite ? (
                <div className="mt-1 flex gap-2">
                  <button className="btn-accent !px-2 !py-0.5 text-xs" disabled={decide.isPending} onClick={() => decide.mutate({ reqId: r.id, decision: "approve" })}>
                    Confirm change
                  </button>
                  <button className="btn !px-2 !py-0.5 text-xs" disabled={decide.isPending} onClick={() => decide.mutate({ reqId: r.id, decision: "decline", note: "Not confirmed by dispatch" })}>
                    Decline
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <ConversationTabs
        storageKey={`staff-${jobId}`}
        fetchSummary={() => apiFetch<ConversationsDto>(API.messages.conversations(jobId))}
        // Staff is a party to two of these (Customer, Rider) and only
        // monitors the third — named plainly either way (spec item 5).
        labelFor={{ customer_dispatch: "Customer", customer_rider: "Customer & Courier", rider_dispatch: "Courier" }}
        renderChat={({ kind, canWrite: conversationWritable }) => (
          <DeliveryChat
            queryKey={`staff-${jobId}-${kind}`}
            quickReplies={[]}
            // A conversation can be monitor-only in its own right (staff
            // can never write into customer_rider, whichever they are),
            // on top of this viewer's own role possibly being read-only
            // (accountant/viewer) even for the conversations they could
            // otherwise post into.
            readOnly={!canWrite || !conversationWritable}
            fetchMessages={() => apiFetch<DeliveryMessagesDto>(API.messages.list(jobId, kind))}
            sendMessage={(body, clientToken) =>
              apiFetch<DeliveryMessagesDto>(API.messages.send(jobId, kind), { method: "POST", body: JSON.stringify({ body, clientToken }) })
            }
            onRealtimeNudge={(refetch) => subscribe(["delivery_message"], (msg) => { if (msg.type === "delivery_message" && msg.payload.jobId === jobId) refetch(); })}
          />
        )}
      />
    </div>
  );
}
