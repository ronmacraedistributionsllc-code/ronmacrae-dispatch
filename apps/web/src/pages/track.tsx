import React from "react";
import { useParams } from "react-router-dom";
import {
  CUSTOMER_JOB_STATUS_LABELS,
  TRACKING_STATE_LABELS,
  type CustomerJobStatus,
  type TrackingPublicDto,
} from "@ronmacrae/contracts";
import { ApiError, apiFetch, formatMoney } from "../lib/api.js";
import { paymentLabel } from "./new-job.js";

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

/**
 * Public customer tracking page (opened from the secure link).
 * No auth: the token in the URL is the credential.
 */
export function Track(): React.JSX.Element {
  const { token = "" } = useParams();
  const query = useQueryLike(`/tracking/${encodeURIComponent(token)}`);
  const { data, error, expired } = query;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <header className="flex items-center justify-between">
        <div>
          <div className="text-base font-bold text-brand-accent">Ronmacrae</div>
          <div className="text-xs uppercase tracking-widest text-zinc-400">Delivery tracking</div>
        </div>
        <a href="/book" className="text-xs text-zinc-500 underline hover:text-zinc-300">
          Book a delivery
        </a>
      </header>

      {expired ? (
        <div className="card">
          <h1 className="text-lg font-semibold text-amber-300">This tracking link is no longer valid</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Ask the store for a new link, or call us on the number you booked with.
          </p>
        </div>
      ) : error ? (
        <div className="card">
          <h1 className="text-lg font-semibold text-red-300">We couldn't find that delivery</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {error instanceof ApiError ? error.message : "Something went wrong."} Please check the link, or contact the
            store.
          </p>
        </div>
      ) : !data ? (
        <div className="card">
          <p className="text-sm text-zinc-400">Loading your delivery…</p>
        </div>
      ) : (
        <>
          <section className="card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="text-lg font-semibold">
                <span className="mr-2 rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                  {data.job.jobNumber ?? data.job.id.slice(0, 8)}
                </span>
                {CUSTOMER_JOB_STATUS_LABELS[data.job.customerStatus as CustomerJobStatus] ?? data.job.customerStatus}
              </h1>
              {data.job.pin ? (
                <span className="text-xs text-zinc-400">
                  Delivery PIN: <span className="font-mono text-sm text-zinc-200">{data.job.pin}</span>
                </span>
              ) : null}
            </div>

            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row label="For" value={data.job.customerName} />
              <Row label="Item" value={data.job.itemSummary ?? "Your order"} />
              <Row label="Deliver to" value={data.job.addressText ?? "—"} />
              {data.job.landmark ? <Row label="Landmark" value={data.job.landmark} /> : null}
              <Row label={data.job.scheduledAt ? "Requested" : "Booked"} value={when(data.job.scheduledAt ?? null)} />
              <Row label="Estimate" value={when(data.location.etaAt ?? data.job.promisedAt)} />
              <Row label="Payment" value={paymentLabel(data.job.paymentMethod)} />
              <Row label="Amount" value={formatMoney(data.job.amountExpected)} />
            </dl>

            {data.rider ? (
              <p className="mt-3 text-sm text-zinc-300">
                Your courier: <span className="font-medium text-zinc-100">{data.rider.name}</span>
              </p>
            ) : null}
          </section>

          <section className="card">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Courier location</h2>
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${
                  data.location.trackingState === "active"
                    ? "bg-emerald-900/50 text-emerald-300"
                    : "bg-zinc-800 text-zinc-400"
                }`}
              >
                {TRACKING_STATE_LABELS[data.location.trackingState]}
              </span>
            </div>
            <p className="mt-2 text-sm text-zinc-400">
              {data.location.point
                ? `Last update ${new Date(data.location.updatedAt ?? data.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
                : "The courier hasn't started yet — you'll see their position here once they're on the way."}
            </p>
          </section>

          <section className="card">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">History</h2>
            {data.statusHistory.length > 0 ? (
              <ol className="space-y-2">
                {[...data.statusHistory].reverse().map((h, i) => (
                  <li key={`${h.status}-${h.at}`} className="flex items-center gap-3 text-sm">
                    <span className="size-2 shrink-0 rounded-full bg-brand-accent" style={{ opacity: 1 - i * 0.15 }} />
                    <span className="text-zinc-200">{CUSTOMER_JOB_STATUS_LABELS[h.status as CustomerJobStatus] ?? h.status}</span>
                    <span className="ml-auto text-xs text-zinc-500">{when(h.at)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-zinc-500">No updates yet.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-right text-zinc-200">{value}</dd>
    </div>
  );
}

/** Tiny polling hook around the public tracking endpoint. */
function useQueryLike(tokenPath: string): {
  data: TrackingPublicDto | null;
  error: unknown;
  expired: boolean;
} {
  const [state, setState] = React.useState<{ data: TrackingPublicDto | null; error: unknown; expired: boolean }>({
    data: null,
    error: null,
    expired: false,
  });

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const body = await apiFetch<TrackingPublicDto>(tokenPath);
        if (alive) setState({ data: body, error: null, expired: body.expired });
      } catch (err) {
        if (alive) {
          const expired = err instanceof ApiError && (err.status === 410 || err.status === 404);
          setState({ data: null, error: expired ? null : err, expired });
        }
      }
    };
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tokenPath]);

  return state;
}
