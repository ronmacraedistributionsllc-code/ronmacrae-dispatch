import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DispatchContactDto, JobDto, JobOfferDto, JobStatus, RiderStatus } from "@ronmacrae/contracts";
import { ACTIVE_JOB_STATUSES, API, TERMINAL_JOB_STATUSES } from "@ronmacrae/contracts";
import { majorOf } from "@ronmacrae/money";
import { ApiError, apiFetch, formatMoney } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { useRealtime } from "../lib/realtime.js";
import { PushOptIn } from "../components/push-opt-in.js";
import { LocationSharing } from "../components/location-sharing.js";
import { RouteQueue } from "../components/route-queue.js";
import { ContactDispatch } from "../components/contact-dispatch.js";
import { DeliveryChat } from "../components/delivery-chat.js";
import { ConversationTabs } from "../components/conversation-tabs.js";
import type { ConversationsDto, DeliveryMessagesDto, RiderCashProfileDto } from "@ronmacrae/contracts";

const RIDER_QUICK_REPLIES = ["Heading to you", "I've arrived", "I cannot reach you", "Please contact dispatch"];

/** Jobs the rider has accepted/been assigned but not yet physically collected. */
const TO_PICK_UP_STATUSES: JobStatus[] = ["assigned", "accepted"];
/** Jobs currently in the rider's hands — collected and moving toward drop-off,
 *  plus the "stuck" statuses (no_answer/location_changed/failed) where the
 *  package is still physically with the rider until the job resolves. */
const IN_POSSESSION_STATUSES: JobStatus[] = ["picked_up", "in_transit", "delivering", "location_changed", "no_answer", "failed"];

type Action = {
  label: string;
  to?: JobStatus;
  stage?: "heading_to_pickup" | "at_pickup";
  needsPin?: boolean;
  /** Collapses two backend transitions into one rider-facing tap (spec item
   *  1's four-step flow: Accept -> Confirm Pickup -> Confirm Delivery ->
   *  Confirm Cash Drop-Off — `in_transit` is a real, useful status for
   *  ETA/tracking/notifications, but the rider should never have to tap a
   *  separate "start delivery" button for it). Applied automatically right
   *  after `to` succeeds. */
  chainTo?: JobStatus;
  /** Shows the cash-collected field, pre-filled from the order total (spec
   *  item 1) — only "Confirm delivery" needs this. */
  needsAmount?: boolean;
  location?: boolean;
  failed?: boolean;
};

/** The ONE big next step for this job — Accept -> Confirm Pickup -> Confirm
 *  Delivery -> Confirm Cash Drop-Off (COD jobs; see CodPanel below for that
 *  last step). Everything else is a secondary/exception action, tucked away
 *  so it can't be tapped by mistake. */
function primaryActionFor(job: JobDto): Action | null {
  switch (job.status) {
    case "assigned": return { label: "Accept job", to: "accepted" };
    case "accepted": return { label: "Confirm pickup", to: "picked_up", chainTo: "in_transit" };
    // Normally skipped in one tap by "Confirm pickup" above — this is only
    // reachable if that chain's second leg didn't complete, so the rider is
    // never stuck with no visible next step.
    case "picked_up": return { label: "Start delivery", to: "in_transit" };
    case "in_transit":
    case "delivering":
      return { label: "Confirm delivery", to: "delivered", needsPin: true, needsAmount: job.paymentMethod === "cod" };
    case "location_changed": return { label: "Resume delivery", to: "in_transit" };
    default: return null; // no_answer / failed: staff/rider judgement call only, via secondary actions
  }
}

/** Statuses where the rider is actually en route to (or at) the customer's
 *  door, so "Customer unavailable" (spec item 6) is promoted out of "Other
 *  options" into its own clearly-visible button rather than hidden away. */
const DELIVERY_ATTEMPT_STATUSES: JobStatus[] = ["picked_up", "in_transit", "delivering", "location_changed"];

function customerUnavailableActionFor(job: JobDto): Action | null {
  return DELIVERY_ATTEMPT_STATUSES.includes(job.status) ? { label: "Customer unavailable", to: "no_answer" } : null;
}

function secondaryActionsFor(job: JobDto): Action[] {
  switch (job.status) {
    case "assigned": return [{ label: "Not Answering", to: "no_answer" }, { label: "Customer Changed Location", to: "location_changed", location: true }, { label: "Failed", to: "failed", failed: true }];
    case "accepted": return [{ label: "Not Answering", to: "no_answer" }, { label: "Customer Changed Location", to: "location_changed", location: true }, { label: "Failed", to: "failed", failed: true }];
    // "Customer unavailable" (same transition as "Not Answering") is already
    // promoted above for these statuses — not repeated here.
    case "picked_up": return [{ label: "Customer Changed Location", to: "location_changed", location: true }, { label: "Failed", to: "failed", failed: true }];
    case "in_transit":
    case "delivering":
      return [{ label: "Customer Changed Location", to: "location_changed", location: true }, { label: "Failed", to: "failed", failed: true }];
    case "no_answer": return [{ label: "Returned to store", to: "returned" }, { label: "Failed", to: "failed", failed: true }];
    case "location_changed": return [{ label: "Failed", to: "failed", failed: true }];
    case "failed": return [{ label: "Returned to store", to: "returned" }];
    default: return [];
  }
}

function dateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("en-JM", { dateStyle: "medium", timeStyle: "short" }) : "Not scheduled";
}

/** Legacy `on_job` rows (from before rider status stopped being auto-managed by
 *  job transitions) still read as "available for jobs" here — it was never a
 *  distinct rider-facing choice, just a byproduct of the bug this fixes. */
function isAvailableForJobs(status: RiderStatus | null): boolean {
  return status === "available" || status === "on_job";
}

/** A rider can carry jobs for several businesses — the business name shown
 *  on a card is always that specific job's business, resolved via its own
 *  jobId (see the dispatch-contact endpoint's own isolation rule). */
function useBusinessName(jobId: string): string {
  const contact = useQuery({
    queryKey: ["dispatch-contact", jobId],
    queryFn: () => apiFetch<DispatchContactDto>(API.bearer.dispatchContact(jobId)),
    staleTime: 5 * 60_000,
  });
  return contact.data?.businessName ?? "Ronmacrae";
}

export function RiderDashboard(): React.JSX.Element {
  const { rider } = useAuth();
  const qc = useQueryClient();
  const [availability, setAvailability] = useState<RiderStatus | null>(rider?.status ?? null);
  useEffect(() => setAvailability(rider?.status ?? null), [rider?.status]);
  const jobs = useQuery({ queryKey: ["bearer-jobs"], queryFn: () => apiFetch<{ jobs: JobDto[] }>(API.bearer.jobs), refetchInterval: 15_000 });
  const offers = useQuery({
    queryKey: ["bearer-offers"],
    queryFn: () => apiFetch<{ offers: JobOfferDto[] }>(API.bearer.offers),
    // Realtime (below) pushes new offers immediately; this interval is the fallback
    // for a dropped connection and for sweeping expired offers off the list.
    refetchInterval: 20_000,
  });
  // A rider can carry several jobs at once — this toggle is the rider's own,
  // explicit "send me more work / don't" choice. It's independent of how many
  // jobs they're already carrying: accepting a job never flips this off, and
  // it stays on (so more offers keep arriving, up to capacity) the whole time.
  const availabilityChange = useMutation({
    mutationFn: (status: "available" | "unavailable") => apiFetch<{ rider: { status: RiderStatus } }>(API.riders.status(rider!.id), { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: ({ rider: updated }) => setAvailability(updated.status),
  });
  const refreshOffersAndJobs = () => {
    void qc.invalidateQueries({ queryKey: ["bearer-offers"] });
    void qc.invalidateQueries({ queryKey: ["bearer-jobs"] });
  };

  const reorder = useMutation({
    mutationFn: (jobIds: string[]) => apiFetch<{ jobs: JobDto[] }>(API.bearer.reorder, { method: "POST", body: JSON.stringify({ jobIds }) }),
    onSuccess: (data) => qc.setQueryData(["bearer-jobs"], { jobs: data.jobs }),
  });

  const { subscribe, onReconnect, status: realtimeStatus } = useRealtime();
  // A direct assignment (job.assigned, source "assign") changes this rider's job
  // list just as much as a new offer does — both should update the screen without
  // waiting for the next poll.
  useEffect(() => subscribe(["offer", "job.assigned"], () => refreshOffersAndJobs()), [subscribe]);
  // Catch up immediately on (re)connect — a dropped socket shouldn't leave a
  // missed offer or a withdrawn/expired one sitting stale until the next poll.
  useEffect(() => onReconnect(() => refreshOffersAndJobs()), [onReconnect]);

  if (!rider) return <p className="text-sm text-zinc-400">Loading rider profile…</p>;

  const allJobs = jobs.data?.jobs ?? [];
  const activeJobs = allJobs.filter((job) => ACTIVE_JOB_STATUSES.includes(job.status));
  const toPickUp = allJobs.filter((job) => TO_PICK_UP_STATUSES.includes(job.status));
  const inPossession = allJobs.filter((job) => IN_POSSESSION_STATUSES.includes(job.status));
  const history = allJobs.filter((job) => TERMINAL_JOB_STATUSES.includes(job.status));
  const capacity = rider.dailyCapacity;
  const atCapacity = activeJobs.length >= capacity;
  const available = isAvailableForJobs(availability);
  const offerCount = offers.data?.offers.length ?? 0;

  return <div className="space-y-4 pb-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-bold">My deliveries</h1><p className="text-sm text-zinc-400">Only jobs assigned to you are shown.</p></div>
      <div className="flex flex-wrap items-center gap-2">
        {realtimeStatus !== "live" ? (
          <span className="rounded bg-amber-900/40 px-2 py-1 text-xs font-medium text-amber-300">
            {realtimeStatus === "reconnecting" ? "Reconnecting…" : "Offline — updates may be delayed"}
          </span>
        ) : null}
        <PushOptIn />
        <button
          className={available ? "btn-accent" : "btn"}
          disabled={availabilityChange.isPending}
          onClick={() => void availabilityChange.mutate(available ? "unavailable" : "available")}
        >
          {available ? "Available for jobs" : "Unavailable"}
        </button>
      </div>
    </header>
    <section className="card flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-sm text-zinc-200">
          <span className="font-semibold">{activeJobs.length}</span> of <span className="font-semibold">{capacity}</span> active job{capacity === 1 ? "" : "s"}
        </p>
        <p className="text-xs text-zinc-500">
          {available
            ? atCapacity
              ? "You're at capacity — no new offers will come in until you finish or drop a job."
              : "You can still receive and accept new offers while carrying these."
            : "You've marked yourself unavailable — you won't receive new offers, but can still finish active jobs."}
        </p>
      </div>
      {atCapacity ? <span className="whitespace-nowrap rounded bg-amber-900/40 px-2 py-1 text-xs font-medium text-amber-300">At capacity</span> : null}
    </section>
    {availabilityChange.error ? <p className="text-sm text-red-400">{availabilityChange.error instanceof ApiError ? availabilityChange.error.message : "Could not update availability"}</p> : null}

    {/* Spec item 4 — a clear, unmissable "Available Jobs" section: jobs
     *  dispatch has offered that this rider can tap to accept. Placed above
     *  everything else on the dashboard since it's the most actionable thing
     *  a rider not already mid-delivery needs to see first. */}
    <SectionHeading label="Available jobs" count={offerCount} />
    {offers.isLoading ? <p className="text-sm text-zinc-400">Checking for available jobs…</p> : null}
    {offerCount === 0 ? (
      <p className="text-sm text-zinc-500">No jobs available right now — they'll appear here the moment dispatch offers one.</p>
    ) : (
      <div className="space-y-2">{offers.data!.offers.map((offer) => <OfferCard key={offer.id} offer={offer} onChanged={refreshOffersAndJobs} />)}</div>
    )}

    {activeJobs.length > 0 ? (
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Route queue</h2>
        {reorder.error ? <p className="text-sm text-red-400">{reorder.error instanceof ApiError ? reorder.error.message : "Could not reorder — try again"}</p> : null}
        <RouteQueue jobs={activeJobs} onReorder={(ids) => reorder.mutate(ids)} reordering={reorder.isPending} />
      </section>
    ) : null}
    <CashSummary />
    <LocationSharing riderId={rider.id} />

    <SectionHeading label="To pick up" count={toPickUp.length} />
    {jobs.isLoading ? <p className="text-sm text-zinc-400">Loading assigned jobs…</p> : null}
    {!jobs.isLoading && toPickUp.length === 0 ? <p className="text-sm text-zinc-500">Nothing waiting for collection.</p> : null}
    <div className="space-y-3">{toPickUp.map((job) => <RiderJobCard key={job.id} job={job} onChanged={() => void qc.invalidateQueries({ queryKey: ["bearer-jobs"] })} />)}</div>

    <SectionHeading label="In my possession" count={inPossession.length} />
    {!jobs.isLoading && inPossession.length === 0 ? <p className="text-sm text-zinc-500">Not carrying any packages right now.</p> : null}
    <div className="space-y-3">{inPossession.map((job) => <RiderJobCard key={job.id} job={job} onChanged={() => void qc.invalidateQueries({ queryKey: ["bearer-jobs"] })} />)}</div>

    {history.length > 0 ? (
      <details className="space-y-2">
        <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-zinc-400">Completed history ({history.length})</summary>
        <div className="mt-2 space-y-2">
          {history.map((job) => <HistoryRow key={job.id} job={job} />)}
        </div>
      </details>
    ) : null}
  </div>;
}

/**
 * Rider cash profile (spec 9, Stage 27) — one card per business the rider
 * is active at, never combined into a single cross-business figure. Every
 * number here is a real sum of actual jobs, computed fresh on each load —
 * never a running total a "hand in" elsewhere could disturb.
 */
function CashSummary(): React.JSX.Element | null {
  const cash = useQuery({
    queryKey: ["bearer-cash"],
    queryFn: () => apiFetch<RiderCashProfileDto>(API.bearer.cash),
    refetchInterval: 30_000,
  });
  const businesses = cash.data?.businesses ?? [];
  const hasAnything = businesses.some(
    (b) => b.collected.count > 0 || b.handedInUnconfirmed.count > 0 || b.disputed.count > 0 || (b.earningsPayable?.amount ?? 0) > 0,
  );
  if (cash.isLoading || businesses.length === 0 || !hasAnything) return null;

  return (
    <details className="card space-y-2" data-testid="rider-cash-summary">
      <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-zinc-400">Cash summary</summary>
      <div className="mt-2 space-y-3">
        {businesses.map((b) => (
          <div key={b.businessId} className="space-y-1 border-t border-zinc-800 pt-2 first:border-t-0 first:pt-0">
            <p className="text-xs font-medium text-zinc-300">{b.businessName}</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
              <div>
                <dt className="label !mb-0">Holding</dt>
                <dd className="text-amber-200">{formatMoney(b.collected.amount)}</dd>
              </div>
              <div>
                <dt className="label !mb-0">Handed in, unconfirmed</dt>
                <dd className="text-zinc-200">{formatMoney(b.handedInUnconfirmed.amount)}</dd>
              </div>
              {b.disputed.count > 0 ? (
                <div>
                  <dt className="label !mb-0">Disputed</dt>
                  <dd className="text-red-300">{formatMoney(b.disputed.amount)}</dd>
                </div>
              ) : null}
              <div>
                <dt className="label !mb-0">Your earnings</dt>
                <dd className="text-emerald-300">{b.earningsPayable ? formatMoney(b.earningsPayable) : "Not set"}</dd>
              </div>
            </dl>
            {b.handoverVariance.amount !== 0 ? (
              <p className="text-xs text-amber-400">
                {b.handoverVariance.amount < 0 ? "Shortage" : "Overage"} on past handovers: {formatMoney(b.handoverVariance)}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-zinc-600">"Your earnings" is an estimate — pay rate × completed deliveries — not a confirmed payout.</p>
    </details>
  );
}

function SectionHeading({ label, count }: { label: string; count: number }): React.JSX.Element {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
      {label}
      <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-bold text-zinc-200">{count}</span>
    </h2>
  );
}

const HISTORY_STATUS_LABEL: Record<string, string> = { delivered: "Delivered", cancelled: "Cancelled", returned: "Returned" };

function HistoryRow({ job }: { job: JobDto }): React.JSX.Element {
  return (
    <div className="card flex flex-wrap items-center justify-between gap-2 !py-2 text-sm">
      <div>
        <span className="font-medium">{job.jobNumber ?? job.id.slice(0, 8)}</span>
        <span className="ml-2 text-zinc-400">{job.itemSummary ?? "—"}</span>
      </div>
      <div className="flex items-center gap-3 text-xs text-zinc-500">
        <span>{dateTime(job.completedAt)}</span>
        <span className="rounded bg-zinc-800 px-2 py-0.5 font-medium text-zinc-300">{HISTORY_STATUS_LABEL[job.status] ?? job.status}</span>
      </div>
    </div>
  );
}

/** Re-renders its caller roughly every `intervalMs` — used to keep an offer's
 *  expiry countdown honest without a server round-trip: expiry is a pure
 *  function of `expiresAt` vs. the clock, so the client can reflect it the
 *  instant it happens rather than waiting for the next poll or realtime push. */
function useClockTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function OfferCard({ offer, onChanged }: { offer: JobOfferDto; onChanged: () => void }): React.JSX.Element {
  const accept = useMutation({
    mutationFn: () => apiFetch(API.bearer.acceptOffer(offer.id), { method: "POST", body: JSON.stringify({}) }),
    onSuccess: onChanged,
  });
  const decline = useMutation({
    mutationFn: () => apiFetch(API.bearer.declineOffer(offer.id), { method: "POST", body: JSON.stringify({}) }),
    onSuccess: onChanged,
  });
  const busy = accept.isPending || decline.isPending;
  const error = accept.error ?? decline.error;
  const now = useClockTick(1_000);
  const msLeft = new Date(offer.expiresAt).getTime() - now;
  const expired = msLeft <= 0;
  const expiresIn = Math.max(0, Math.round(msLeft / 60_000));

  return <section className={`card space-y-2 border ${offer.urgent ? "border-red-800/60" : "border-sky-800/50"}`}>
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="font-semibold">
          {offer.urgent ? <span className="mr-2 rounded bg-red-900/70 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-200">Urgent</span> : null}
          {offer.pickupArea ?? "Pickup TBC"} → {offer.destinationArea ?? "Destination TBC"}
        </h2>
        <p className="text-xs text-zinc-400">{offer.itemSummary ?? "No item details"}</p>
      </div>
      <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${expired ? "bg-zinc-800 text-zinc-500" : "bg-sky-900/50 text-sky-300"}`}>
        {expired ? "expired" : `expires in ${expiresIn}m`}
      </span>
    </div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
      <div><dt className="label !mb-0">Your earnings</dt><dd className="text-zinc-200">{formatMoney(offer.riderEarnings)}</dd></div>
      <div><dt className="label !mb-0">Delivery fee</dt><dd className="text-zinc-200">{formatMoney(offer.deliveryFee)}</dd></div>
      <div><dt className="label !mb-0">Cash to collect</dt><dd className="text-zinc-200">{formatMoney(offer.codAmount)}</dd></div>
    </dl>
    {error ? <p className="text-sm text-red-400">{error instanceof ApiError ? error.message : "Could not respond to offer"}</p> : null}
    {expired ? (
      <p className="text-sm text-zinc-500">This offer has expired.</p>
    ) : (
      <div className="flex gap-2">
        <button className="btn-accent" disabled={busy} onClick={() => void accept.mutate()}>{accept.isPending ? "Accepting…" : "Accept"}</button>
        <button className="btn" disabled={busy} onClick={() => void decline.mutate()}>{decline.isPending ? "Declining…" : "Decline"}</button>
      </div>
    )}
  </section>;
}

/** Universal maps deep link — opens the destination in whatever maps app the
 *  device already has (falls back to Google Maps in a browser); we never
 *  claim to know which navigation app is installed, this link format just
 *  works with all of them. */
function navigateHref(job: JobDto): string {
  if (job.point) return `https://www.google.com/maps/dir/?api=1&destination=${job.point.lat},${job.point.lng}`;
  const q = encodeURIComponent([job.addressText, job.landmark].filter(Boolean).join(", ") || "destination");
  return `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}

function RiderJobCard({ job, onChanged }: { job: JobDto; onChanged: () => void }): React.JSX.Element {
  const businessName = useBusinessName(job.id);
  const [sheet, setSheet] = useState<Action | null>(null);
  const [note, setNote] = useState("");
  const [pin, setPin] = useState("");
  const [amount, setAmount] = useState(() => String(job.amountExpected ? majorOf(job.amountExpected) : ""));
  const [addressText, setAddressText] = useState(job.addressText ?? "");
  const [landmark, setLandmark] = useState(job.landmark ?? "");
  const [showMore, setShowMore] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const mutation = useMutation({
    mutationFn: async (next: Action) => {
      if (next.label === "Accept job") return apiFetch(API.bearer.accept(job.id), { method: "POST", body: JSON.stringify({}) });
      const result = await apiFetch(API.bearer.transition(job.id), {
        method: "POST",
        body: JSON.stringify({
          to: next.to,
          note,
          ...(next.needsPin ? { pin } : {}),
          ...(next.needsAmount && amount.trim() !== "" ? { amountCollected: Number(amount) } : {}),
          ...(next.location ? { addressText, landmark } : {}),
          ...(next.failed ? { failureReason: "other", failureNote: note } : {}),
        }),
      });
      // Collapses "Confirm pickup" (picked_up) straight into in_transit — one
      // rider-facing tap instead of two (spec item 1). If this second leg
      // fails, the job is left at `picked_up` and "Start delivery" appears
      // as a normal fallback next step rather than the rider being stuck.
      if (next.chainTo) return apiFetch(API.bearer.transition(job.id), { method: "POST", body: JSON.stringify({ to: next.chainTo }) });
      return result;
    },
    // Data entered in the sheet (note/pin/etc.) is deliberately left in place
    // on success too — closing it clears the sheet, not what was typed, so a
    // slow network retry never loses what the rider already entered.
    onSuccess: () => { setSheet(null); onChanged(); },
  });
  const urgent = job.priority === "urgent";
  const primary = primaryActionFor(job);
  const unavailable = customerUnavailableActionFor(job);
  const secondary = secondaryActionsFor(job);
  const jobLabel = job.jobNumber ?? job.id.slice(0, 8);

  return <section className={`card space-y-3 ${urgent ? "border-red-900/50 bg-red-950/10" : ""}`}>
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{businessName}</p>
        <h2 className="font-semibold">{jobLabel}</h2>
        <p className="text-xs text-zinc-400">{job.status.replaceAll("_", " ")}</p>
      </div>
      {urgent ? <span className="whitespace-nowrap rounded bg-red-900/70 px-2 py-1 text-xs font-bold uppercase tracking-wide text-red-200">Urgent</span> : null}
    </div>

    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
      {/* Customer name only — never the phone number here. Message the
       *  customer through the in-app chat below, not by dialing directly. */}
      <div><dt className="label !mb-0">Customer</dt><dd className="break-words text-zinc-200">{job.customerName}</dd></div>
      <div><dt className="label !mb-0">Product</dt><dd className="break-words text-zinc-200">{job.itemSummary ?? "—"}{job.quantity && job.quantity > 1 ? ` × ${job.quantity}` : ""}</dd></div>
      <div><dt className="label !mb-0">Size / colour</dt><dd className="break-words text-zinc-200">{[job.itemSize ?? job.packageSize, job.itemColor].filter(Boolean).join(" · ") || "—"}</dd></div>
      <div><dt className="label !mb-0">Pickup</dt><dd className="break-words text-zinc-200">{job.pickupAddressText ?? "Not supplied"}</dd></div>
      <div><dt className="label !mb-0">Destination</dt><dd className="break-words text-zinc-200">{job.addressText ?? "Not supplied"}{job.landmark ? ` (${job.landmark})` : ""}</dd></div>
    </dl>

    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-zinc-900/40 p-2.5 text-sm sm:grid-cols-3">
      <div><dt className="label !mb-0">Cash to collect</dt><dd className="font-semibold text-amber-200">{job.paymentMethod === "cod" ? formatMoney(job.amountExpected) : "Not COD"}</dd></div>
      <div><dt className="label !mb-0">Your delivery fee</dt><dd className="font-semibold text-emerald-300">{formatMoney(job.fee)}</dd></div>
      <div><dt className="label !mb-0">Requested</dt><dd className="text-zinc-300">{dateTime(job.scheduledAt)}</dd></div>
    </dl>

    {job.instructions ? <p className="text-sm text-zinc-400">Instructions: {job.instructions}</p> : null}
    {job.pin ? <p className="rounded-lg bg-amber-900/30 p-3 text-sm text-amber-200">Delivery PIN: <strong className="tracking-widest">{job.pin}</strong></p> : null}
    {job.paymentMethod === "cod" ? <CodPanel job={job} onChanged={onChanged} /> : null}

    <div className="flex flex-wrap gap-2">
      <a className="btn !px-3 !py-1.5 text-sm" href={navigateHref(job)} target="_blank" rel="noreferrer">📍 Navigate</a>
      {/* Opens both the Customer and Dispatch conversations (tabs) — see
       *  RiderJobChat below. Labeled plainly as "Messages" rather than
       *  "Message customer" so dispatch messaging isn't hidden behind a
       *  button that only names the other party (spec item 5). */}
      <button className="btn !px-3 !py-1.5 text-sm" onClick={() => setShowChat((v) => !v)}>💬 Messages</button>
    </div>
    {ACTIVE_JOB_STATUSES.includes(job.status) ? <ContactDispatch jobId={job.id} jobLabel={jobLabel} /> : null}
    {showChat ? (
      <div className="rounded-lg border border-zinc-700 p-3">
        <RiderJobChat jobId={job.id} />
      </div>
    ) : null}

    {/* The one primary action — a job-specific confirmation sheet, never a
     *  silent/automatic status change. */}
    {primary ? (
      <button className="btn-accent w-full !py-3 text-base font-semibold" onClick={() => setSheet(primary)}>
        {primary.label}
      </button>
    ) : null}

    {/* Promoted out of "Other options" (spec item 6) — a rider trying to
     *  deliver and failing to reach the customer needs this as obviously as
     *  the primary action, not buried behind a toggle. Never marks the
     *  delivery complete; just flags it for dispatch. */}
    {unavailable ? (
      <button className="btn w-full !border-amber-800/60 !bg-amber-950/20 !py-2.5 text-sm font-medium text-amber-300" onClick={() => setSheet(unavailable)}>
        🚫 Customer unavailable
      </button>
    ) : null}

    {secondary.length > 0 ? (
      <div>
        <button className="text-xs text-zinc-500 underline hover:text-zinc-300" onClick={() => setShowMore((v) => !v)}>
          {showMore ? "Hide other options" : "Other options (not answering, wrong address, failed…)"}
        </button>
        {showMore ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {secondary.map((next) => <button key={next.label} className="btn !px-2.5 !py-1 text-xs" onClick={() => setSheet(next)}>{next.label}</button>)}
          </div>
        ) : null}
      </div>
    ) : null}

    {sheet ? (
      <ActionSheet
        job={job}
        businessName={businessName}
        action={sheet}
        note={note}
        setNote={setNote}
        pin={pin}
        setPin={setPin}
        amount={amount}
        setAmount={setAmount}
        addressText={addressText}
        setAddressText={setAddressText}
        landmark={landmark}
        setLandmark={setLandmark}
        pending={mutation.isPending}
        error={mutation.error instanceof ApiError ? mutation.error.message : mutation.error ? "Could not update this job — try again" : null}
        onConfirm={() => void mutation.mutate(sheet)}
        onDismiss={() => setSheet(null)}
      />
    ) : null}
  </section>;
}

const PRIMARY_SHEET_COPY: Record<string, { question: string; confirmLabel: string }> = {
  "Confirm pickup": { question: "Confirm you have the correct package in hand before heading out.", confirmLabel: "Yes, confirm pickup" },
  "Start delivery": { question: "Confirm you're heading out with this package now.", confirmLabel: "Start delivery" },
  "Confirm delivery": { question: "Enter the delivery PIN from the customer to confirm handoff.", confirmLabel: "Confirm delivered" },
  "Accept job": { question: "Confirm you can pick up and deliver this job.", confirmLabel: "Accept" },
  "Customer unavailable": { question: "This records that you tried to reach the customer and lets dispatch know — it does NOT mark the delivery complete. You'll still have the package.", confirmLabel: "Confirm customer unavailable" },
};

/**
 * Job-specific confirmation popup / mobile bottom sheet (spec item 1) for
 * every rider action — primary 3-step actions and the secondary/exception
 * ones alike, so nothing ever changes status from a single accidental tap.
 * Dismissible (backdrop, Escape, or Cancel) without losing anything already
 * typed — `note`/`pin`/etc. live in the parent card, not this component, so
 * closing and reopening the sheet keeps them.
 */
function ActionSheet(props: {
  job: JobDto;
  businessName: string;
  action: Action;
  note: string;
  setNote: (v: string) => void;
  pin: string;
  setPin: (v: string) => void;
  amount: string;
  setAmount: (v: string) => void;
  addressText: string;
  setAddressText: (v: string) => void;
  landmark: string;
  setLandmark: (v: string) => void;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const { job, businessName, action, note, setNote, pin, setPin, amount, setAmount, addressText, setAddressText, landmark, setLandmark, pending, error, onConfirm, onDismiss } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);
  const copy = PRIMARY_SHEET_COPY[action.label];
  const jobLabel = job.jobNumber ?? job.id.slice(0, 8);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" role="dialog" aria-modal="true" aria-label={action.label} onClick={onDismiss}>
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-zinc-900 p-4 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 h-1 w-10 self-center rounded-full bg-zinc-700 sm:hidden" />
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{businessName} · {jobLabel}</p>
        <h3 className="mt-1 text-lg font-semibold">{action.label}</h3>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <div><dt className="label !mb-0">Item</dt><dd className="text-zinc-200">{job.itemSummary ?? "—"}</dd></div>
          <div><dt className="label !mb-0">Destination</dt><dd className="text-zinc-200">{job.addressText ?? "—"}</dd></div>
        </dl>
        {copy ? <p className="mt-3 rounded-lg bg-zinc-800/60 p-2.5 text-sm text-zinc-300">{copy.question}</p> : null}

        {action.needsAmount ? (
          <div className="mt-3">
            <label className="label" htmlFor={`amount-${job.id}`}>Cash collected</label>
            <input id={`amount-${job.id}`} className="input" type="number" min={0} step="any" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <p className="mt-1 text-xs text-zinc-500">Defaults to the order total — change it only if the customer actually paid a different amount.</p>
          </div>
        ) : null}
        {action.needsPin ? (
          <div className="mt-3">
            <label className="label" htmlFor={`pin-${job.id}`}>Delivery PIN</label>
            <input id={`pin-${job.id}`} className="input" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value)} />
          </div>
        ) : null}
        {action.location ? (
          <div className="mt-3 space-y-2">
            <div><label className="label" htmlFor={`address-${job.id}`}>New destination</label><input id={`address-${job.id}`} className="input" value={addressText} onChange={(e) => setAddressText(e.target.value)} /></div>
            <div><label className="label" htmlFor={`landmark-${job.id}`}>New landmark</label><input id={`landmark-${job.id}`} className="input" value={landmark} onChange={(e) => setLandmark(e.target.value)} /></div>
          </div>
        ) : null}
        <div className="mt-3">
          <label className="label" htmlFor={`note-${job.id}`}>Note (optional)</label>
          <textarea id={`note-${job.id}`} className="input min-h-16" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional proof or action note" />
        </div>
        {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
        <div className="mt-4 flex gap-2">
          <button className="btn-accent flex-1 !py-2.5" disabled={pending || (action.needsPin && pin === "")} onClick={onConfirm}>
            {pending ? "Saving…" : (copy?.confirmLabel ?? "Confirm")}
          </button>
          <button className="btn !py-2.5" disabled={pending} onClick={onDismiss}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const COD_STATUS_LABEL: Record<string, string> = {
  pending_collection: "Pending collection",
  collected: "Collected",
  handed_in: "Handed in",
  disputed: "Disputed",
  approved: "Approved",
};
const COD_STATUS_BADGE: Record<string, string> = {
  pending_collection: "bg-zinc-800 text-zinc-300",
  collected: "bg-sky-900/50 text-sky-300",
  handed_in: "bg-amber-900/40 text-amber-300",
  disputed: "bg-red-900/60 text-red-200",
  approved: "bg-emerald-900/50 text-emerald-300",
};

/**
 * Cash-drop-off panel for one job's card (spec items 1 &amp; 8) — kept
 * deliberately separate from "Your delivery fee" above it (this is only the
 * cash-in-hand side of the job: what was collected from the customer, and
 * what's been handed over to the office; it is never the rider's own
 * earnings, which is a different figure entirely, shown on the offer card
 * before acceptance and as "Your delivery fee" above once assigned).
 *
 * There is no separate "Record collected" step here anymore — confirming
 * delivery (the ActionSheet's amount field above) already records the
 * collection automatically. This panel picks up from there: the rider
 * presses "Confirm Cash Drop-Off" once the money is actually handed over,
 * and dispatch approves it from their side (COD reconciliation page).
 */
function CodPanel({ job, onChanged }: { job: JobDto; onChanged: () => void }): React.JSX.Element {
  const [handInOpen, setHandInOpen] = useState(false);
  const [handInAmount, setHandInAmount] = useState(() => String(job.amountCollected ? majorOf(job.amountCollected) : ""));

  const handIn = useMutation({
    mutationFn: () => apiFetch(API.cod.handIn(job.id), { method: "POST", body: JSON.stringify({ amountHandedIn: Number(handInAmount) }) }),
    onSuccess: () => { setHandInOpen(false); onChanged(); },
  });

  const locked = job.codStatus === "approved";
  const canHandIn = !locked && (job.codStatus === "collected" || job.codStatus === "handed_in");

  return (
    <div className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-zinc-200">Cash on delivery</p>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${COD_STATUS_BADGE[job.codStatus]}`}>{COD_STATUS_LABEL[job.codStatus]}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <div><dt className="label !mb-0">Expected</dt><dd className="text-zinc-200">{formatMoney(job.amountExpected)}</dd></div>
        <div><dt className="label !mb-0">Collected</dt><dd className="text-zinc-200">{formatMoney(job.amountCollected)}</dd></div>
        <div><dt className="label !mb-0">Handed in</dt><dd className="text-zinc-200">{formatMoney(job.codHandedInAmount)}</dd></div>
      </dl>
      {job.codVarianceMinor != null && job.codVarianceMinor !== 0 ? (
        <p className={`text-xs ${job.codVarianceMinor < 0 ? "text-red-400" : "text-amber-300"}`}>
          {job.codVarianceMinor < 0 ? "Shortage" : "Overage"}: {formatMoney({ amount: Math.abs(job.codVarianceMinor), currency: job.amountExpected?.currency ?? "JMD" })}
        </p>
      ) : null}
      {job.codAccountantNote ? <p className="text-xs text-zinc-400">Accountant note: {job.codAccountantNote}</p> : null}
      {locked ? (
        <p className="text-xs text-zinc-500">Approved by dispatch — locked. Contact an accountant if this needs correcting.</p>
      ) : job.codStatus === "handed_in" ? (
        <p className="text-xs text-zinc-500">Waiting on dispatch to approve this drop-off.</p>
      ) : canHandIn ? (
        <div className="flex flex-wrap gap-2">
          <button className="btn-accent !px-3 !py-1 text-xs" onClick={() => setHandInOpen((v) => !v)}>Confirm cash drop-off</button>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">Nothing to hand over yet — this is recorded automatically once you confirm delivery.</p>
      )}
      {handInOpen ? (
        <div className="flex flex-wrap items-end gap-2 rounded border border-zinc-700 p-2">
          <div>
            <label className="label" htmlFor={`handin-${job.id}`}>Amount handed in to the office</label>
            <input id={`handin-${job.id}`} className="input w-32" type="number" min={0} step="any" value={handInAmount} onChange={(e) => setHandInAmount(e.target.value)} />
          </div>
          <button className="btn-accent !px-3 !py-1 text-xs" disabled={handIn.isPending} onClick={() => void handIn.mutate()}>{handIn.isPending ? "Saving…" : "Save"}</button>
          {handIn.error ? <p className="w-full text-xs text-red-400">{handIn.error instanceof ApiError ? handIn.error.message : "Could not record handover"}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function RiderJobChat({ jobId }: { jobId: string }): React.JSX.Element {
  const { subscribe } = useRealtime();
  return (
    <ConversationTabs
      storageKey={`rider-${jobId}`}
      fetchSummary={() => apiFetch<ConversationsDto>(API.messages.bearerConversations(jobId))}
      // A rider's own two conversations, named plainly from their side
      // (spec item 5) — not "Customer ↔ Rider" / "Rider ↔ Dispatch".
      labelFor={{ customer_rider: "Customer", rider_dispatch: "Dispatch" }}
      renderChat={({ kind }) => (
        <DeliveryChat
          queryKey={`rider-${jobId}-${kind}`}
          quickReplies={RIDER_QUICK_REPLIES}
          fetchMessages={() => apiFetch<DeliveryMessagesDto>(API.messages.bearerList(jobId, kind))}
          sendMessage={(body, clientToken) =>
            apiFetch<DeliveryMessagesDto>(API.messages.bearerSend(jobId, kind), { method: "POST", body: JSON.stringify({ body, clientToken }) })
          }
          onRealtimeNudge={(refetch) => subscribe(["delivery_message"], (msg) => { if (msg.type === "delivery_message" && msg.payload.jobId === jobId) refetch(); })}
          addressChange={{
            onPropose: async (proposedAddressText) => {
              await apiFetch(API.messages.bearerAddressChange(jobId), { method: "POST", body: JSON.stringify({ proposedAddressText }) });
            },
          }}
        />
      )}
    />
  );
}
