import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobDto, JobOfferDto, JobStatus, RiderStatus } from "@ronmacrae/contracts";
import { ACTIVE_JOB_STATUSES, API } from "@ronmacrae/contracts";
import { ApiError, apiFetch, formatMoney } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { useRealtime } from "../lib/realtime.js";
import { PushOptIn } from "../components/push-opt-in.js";
import { LocationSharing } from "../components/location-sharing.js";

type Action = { label: string; to?: JobStatus; stage?: "heading_to_pickup" | "at_pickup"; needsPin?: boolean; location?: boolean; failed?: boolean };

function actionsFor(job: JobDto): Action[] {
  switch (job.status) {
    case "assigned": return [{ label: "Accept", to: "accepted" }, { label: "Not Answering", to: "no_answer" }, { label: "Customer Changed Location", to: "location_changed", location: true }, { label: "Failed", to: "failed", failed: true }];
    case "accepted": return [{ label: "Heading to Pickup", stage: "heading_to_pickup" }, { label: "Arrived at Pickup", stage: "at_pickup" }, { label: "Collected", to: "picked_up" }, { label: "Not Answering", to: "no_answer" }, { label: "Customer Changed Location", to: "location_changed", location: true }, { label: "Failed", to: "failed", failed: true }];
    case "picked_up": return [{ label: "In Transit", to: "in_transit" }, { label: "Arrived at Destination", to: "delivering" }, { label: "Not Answering", to: "no_answer" }, { label: "Customer Changed Location", to: "location_changed", location: true }, { label: "Failed", to: "failed", failed: true }];
    case "in_transit": return [{ label: "Arrived at Destination", to: "delivering" }, { label: "Delivered", to: "delivered", needsPin: true }, { label: "Not Answering", to: "no_answer" }, { label: "Customer Changed Location", to: "location_changed", location: true }, { label: "Failed", to: "failed", failed: true }];
    case "delivering": return [{ label: "Delivered", to: "delivered", needsPin: true }, { label: "In Transit", to: "in_transit" }, { label: "Not Answering", to: "no_answer" }, { label: "Customer Changed Location", to: "location_changed", location: true }, { label: "Failed", to: "failed", failed: true }];
    case "no_answer": return [{ label: "Returned", to: "returned" }, { label: "Failed", to: "failed", failed: true }];
    case "location_changed": return [{ label: "In Transit", to: "in_transit" }, { label: "Arrived at Destination", to: "delivering" }, { label: "Not Answering", to: "no_answer" }, { label: "Failed", to: "failed", failed: true }];
    case "failed": return [{ label: "Returned", to: "returned" }];
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

  const { subscribe } = useRealtime();
  useEffect(() => subscribe(["offer"], () => refreshOffersAndJobs()), [subscribe]);

  if (!rider) return <p className="text-sm text-zinc-400">Loading rider profile…</p>;

  const activeJobs = (jobs.data?.jobs ?? []).filter((job) => ACTIVE_JOB_STATUSES.includes(job.status));
  const capacity = rider.dailyCapacity;
  const atCapacity = activeJobs.length >= capacity;
  const available = isAvailableForJobs(availability);

  return <div className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-bold">My deliveries</h1><p className="text-sm text-zinc-400">Only jobs assigned to you are shown.</p></div>
      <div className="flex flex-wrap items-center gap-2">
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
    <LocationSharing riderId={rider.id} />
    {availabilityChange.error ? <p className="text-sm text-red-400">{availabilityChange.error instanceof ApiError ? availabilityChange.error.message : "Could not update availability"}</p> : null}
    {offers.data && offers.data.offers.length > 0 ? (
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Job offers</h2>
        {offers.data.offers.map((offer) => <OfferCard key={offer.id} offer={offer} onChanged={refreshOffersAndJobs} />)}
      </section>
    ) : null}
    {jobs.isLoading ? <p className="text-sm text-zinc-400">Loading assigned jobs…</p> : null}
    {jobs.data?.jobs.map((job) => <RiderJobCard key={job.id} job={job} onChanged={() => void qc.invalidateQueries({ queryKey: ["bearer-jobs"] })} />)}
    {jobs.data && jobs.data.jobs.length === 0 ? <section className="card text-sm text-zinc-400">No deliveries are assigned to you.</section> : null}
  </div>;
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
  const expiresIn = Math.max(0, Math.round((new Date(offer.expiresAt).getTime() - Date.now()) / 60_000));

  return <section className={`card space-y-2 border ${offer.urgent ? "border-red-800/60" : "border-sky-800/50"}`}>
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="font-semibold">
          {offer.urgent ? <span className="mr-2 rounded bg-red-900/70 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-200">Urgent</span> : null}
          {offer.pickupArea ?? "Pickup TBC"} → {offer.destinationArea ?? "Destination TBC"}
        </h2>
        <p className="text-xs text-zinc-400">{offer.itemSummary ?? "No item details"}</p>
      </div>
      <span className="whitespace-nowrap rounded bg-sky-900/50 px-2 py-1 text-xs font-medium text-sky-300">
        expires in {expiresIn}m
      </span>
    </div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
      <div><dt className="label !mb-0">Your earnings</dt><dd className="text-zinc-200">{formatMoney(offer.riderEarnings)}</dd></div>
      <div><dt className="label !mb-0">Delivery fee</dt><dd className="text-zinc-200">{formatMoney(offer.deliveryFee)}</dd></div>
      <div><dt className="label !mb-0">COD amount</dt><dd className="text-zinc-200">{formatMoney(offer.codAmount)}</dd></div>
    </dl>
    {error ? <p className="text-sm text-red-400">{error instanceof ApiError ? error.message : "Could not respond to offer"}</p> : null}
    <div className="flex gap-2">
      <button className="btn-accent" disabled={busy} onClick={() => void accept.mutate()}>{accept.isPending ? "Accepting…" : "Accept"}</button>
      <button className="btn" disabled={busy} onClick={() => void decline.mutate()}>{decline.isPending ? "Declining…" : "Decline"}</button>
    </div>
  </section>;
}

function RiderJobCard({ job, onChanged }: { job: JobDto; onChanged: () => void }): React.JSX.Element {
  const [action, setAction] = useState<Action | null>(null);
  const [note, setNote] = useState("");
  const [pin, setPin] = useState("");
  const [addressText, setAddressText] = useState(job.addressText ?? "");
  const [landmark, setLandmark] = useState(job.landmark ?? "");
  const mutation = useMutation({
    mutationFn: async (next: Action) => {
      if (next.stage) return apiFetch(API.bearer.stage(job.id), { method: "POST", body: JSON.stringify({ stage: next.stage, note }) });
      if (next.label === "Accept") return apiFetch(API.bearer.accept(job.id), { method: "POST", body: JSON.stringify({}) });
      return apiFetch(API.bearer.transition(job.id), { method: "POST", body: JSON.stringify({ to: next.to, note, ...(next.needsPin ? { pin } : {}), ...(next.location ? { addressText, landmark } : {}), ...(next.failed ? { failureReason: "other", failureNote: note } : {}) }) });
    },
    onSuccess: () => { setAction(null); setNote(""); setPin(""); onChanged(); },
  });
  const urgent = job.priority === "urgent";
  const fields = [
    ["Customer", `${job.customerName} · ${job.customerPhone}`], ["Pickup", job.pickupAddressText ?? "Not supplied"], ["Destination", job.addressText ?? "Not supplied"], ["Landmark", job.landmark ?? "—"],
    ["Products", job.itemSummary ?? "—"], ["Colour", job.itemColor ?? "—"], ["Size", job.itemSize ?? job.packageSize ?? "—"], ["Quantity", String(job.quantity ?? 1)],
    ["Order value", formatMoney(job.fare)], ["Delivery fee", formatMoney(job.fee)], ["Payment", job.paymentMethod], ["COD amount", formatMoney(job.amountExpected)], ["Requested date", dateTime(job.scheduledAt)], ["Instructions", job.instructions ?? "—"],
  ];
  return <section className={`card space-y-3 ${urgent ? "border-red-900/50 bg-red-950/10" : ""}`}>
    <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{job.jobNumber ?? job.id.slice(0, 8)}</h2><p className="text-xs text-zinc-400">{job.status.replaceAll("_", " ")} · {job.stage.replaceAll("_", " ")}</p></div><span className={`rounded px-2 py-1 text-xs font-medium ${urgent ? "bg-red-900/70 uppercase tracking-wide text-red-200" : "bg-zinc-800 text-zinc-200"}`}>{urgent ? "Urgent" : job.priority}</span></div>
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">{fields.map(([label, value]) => <div key={label}><dt className="label !mb-0">{label}</dt><dd className="break-words text-zinc-200">{value}</dd></div>)}</dl>
    {job.pin ? <p className="rounded-lg bg-amber-900/30 p-3 text-sm text-amber-200">Delivery PIN: <strong className="tracking-widest">{job.pin}</strong></p> : null}
    {action ? <div className="space-y-2 rounded-lg border border-zinc-700 p-3"><p className="text-sm font-medium">{action.label}</p><label className="label" htmlFor={`note-${job.id}`}>Proof / action notes</label><textarea id={`note-${job.id}`} className="input min-h-20" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional delivery proof or action note" />
      {action.needsPin ? <><label className="label" htmlFor={`pin-${job.id}`}>Delivery PIN</label><input id={`pin-${job.id}`} className="input" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} /></> : null}
      {action.location ? <><label className="label" htmlFor={`address-${job.id}`}>New destination</label><input id={`address-${job.id}`} className="input" value={addressText} onChange={(e) => setAddressText(e.target.value)} /><label className="label" htmlFor={`landmark-${job.id}`}>New landmark</label><input id={`landmark-${job.id}`} className="input" value={landmark} onChange={(e) => setLandmark(e.target.value)} /></> : null}
      {mutation.error ? <p className="text-sm text-red-400">{mutation.error instanceof ApiError ? mutation.error.message : "Could not update job"}</p> : null}
      <div className="flex gap-2"><button className="btn-accent" disabled={mutation.isPending || (action.needsPin && pin === "")} onClick={() => void mutation.mutate(action)}>{mutation.isPending ? "Saving…" : "Confirm"}</button><button className="btn" disabled={mutation.isPending} onClick={() => setAction(null)}>Cancel</button></div>
    </div> : <div className="flex flex-wrap gap-2">{actionsFor(job).map((next) => <button key={next.label} className="btn" onClick={() => setAction(next)}>{next.label}</button>)}</div>}
  </section>;
}
