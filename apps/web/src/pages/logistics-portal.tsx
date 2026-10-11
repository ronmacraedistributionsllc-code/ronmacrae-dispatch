import React, { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { API } from "@ronmacrae/contracts";
import type { LogisticsFleetJobDto, PlatformMessagesDto } from "@ronmacrae/contracts";
import { setAccessToken } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { PlatformChat } from "../components/platform-chat.js";
import { DeleteAccountPanel } from "../components/delete-account-panel.js";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const STORAGE_KEY = "logisticsPortalToken";

class PortalError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Deliberately separate, minimal fetch helper — same reasoning as
 *  merchant-portal.tsx's portalFetch: this session has nothing to do with
 *  the staff session's refresh flow. */
async function portalFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiPath = path.startsWith("/api/") ? path.slice(4) : path;
  const res = await fetch(`${API_BASE}${apiPath}`, {
    ...init,
    headers: {
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new PortalError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

interface FleetRider {
  id: string;
  name: string;
  phone: string;
  vehicle: string;
  status: string;
  active: boolean;
  platformStatus: string;
  dailyCapacity: number;
  activeJobCount: number;
}

const STATUS_LABEL: Record<string, string> = { offline: "Offline", available: "Available", on_job: "On a job", unavailable: "Unavailable" };
const STATUS_DOT: Record<string, string> = { offline: "bg-zinc-600", available: "bg-emerald-500", on_job: "bg-sky-500", unavailable: "bg-amber-500" };
const JOB_STATUS_LABEL: Record<string, string> = {
  new: "New", assigned: "Assigned", accepted: "Accepted", picked_up: "Picked up", in_transit: "In transit",
  delivering: "Delivering", delivered: "Delivered", no_answer: "No answer", location_changed: "Address changed",
  failed: "Failed", returned: "Returned", cancelled: "Cancelled",
};

/** Spec: "logistics-company dashboard" — what this rider is actually
 *  delivering, not just their idle/available status (see the API route's
 *  own doc comment for exactly what's deliberately left out: no customer
 *  name/phone/exact address, since this company doesn't own that
 *  relationship). */
function RiderJobsPanel({ token, riderId }: { token: string; riderId: string }): React.JSX.Element {
  const [jobs, setJobs] = useState<LogisticsFleetJobDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    portalFetch<{ jobs: LogisticsFleetJobDto[] }>(API.logisticsPortal.riderJobs(riderId), { headers: { authorization: `Bearer ${token}` } })
      .then((r) => !cancelled && setJobs(r.jobs))
      .catch((err) => !cancelled && setError(err instanceof PortalError ? err.message : "Could not load deliveries"));
    return () => {
      cancelled = true;
    };
  }, [token, riderId]);

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (jobs === null) return <p className="text-xs text-zinc-500">Loading deliveries…</p>;
  if (jobs.length === 0) return <p className="text-xs text-zinc-500">No deliveries yet.</p>;
  return (
    <ul className="space-y-1.5 rounded-lg border border-zinc-800 p-2 text-xs">
      {jobs.map((j) => (
        <li key={j.id} className="flex items-center justify-between gap-2">
          <span className="text-zinc-300">
            {j.jobNumber ?? "—"} · {j.itemSummary ?? "—"}
            {j.zoneName ? <span className="text-zinc-500"> · {j.zoneName}</span> : null}
          </span>
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-medium text-zinc-400">{JOB_STATUS_LABEL[j.status] ?? j.status}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A logistics/bearer company's own login — a read-only fleet dashboard
 * scoped to exactly its own attached riders. Its own auth "face"
 * (logistics-portal.ts's logistics_portal token), same pattern as
 * merchant-portal.tsx. Which riders show up here is a Platform Admin
 * decision (Rider.attachedLogisticsCompanyId) — this portal can look, not
 * assign.
 */
/**
 * Add one of your own bearers: creates the rider attached to this company
 * (pending platform vetting) plus a pending membership for the business
 * to approve. Rejects duplicates by phone — one account per courier.
 */
function AddFleetRider({ token, onAdded }: { token: string | null; onAdded: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!token) return <></>;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await portalFetch(API.logisticsPortal.addRider, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() }),
      });
      setName("");
      setPhone("");
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not add this courier");
    } finally {
      setBusy(false);
    }
  }
  if (!open) {
    return <button type="button" className="btn-accent" onClick={() => setOpen(true)}>+ Add your bearer</button>;
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="card space-y-2">
      <p className="text-sm font-medium">Add one of your bearers</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="fleet-rider-name">Full name</label>
          <input id="fleet-rider-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="fleet-rider-phone">Phone</label>
          <input id="fleet-rider-phone" className="input" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="876 555 1234" />
        </div>
      </div>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <div className="flex gap-2">
        <button className="btn-accent" disabled={busy}>{busy ? "Adding…" : "Add bearer"}</button>
        <button type="button" className="btn" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * Release a bearer back to freelance: they keep account, history, and
 * memberships — they just stop being this company's fleet. Refuses while
 * they're carrying live work (finish first, then detach).
 */
function DetachFleetRider({ token, rider, onChanged }: { token: string | null; rider: FleetRider; onChanged: () => void }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!token) return <></>;
  async function detach() {
    setError(null);
    setBusy(true);
    try {
      await portalFetch(API.logisticsPortal.detachRider(rider.id), { method: "POST", headers: { authorization: `Bearer ${token}` } });
      setConfirming(false);
      onChanged();
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not release this courier");
    } finally {
      setBusy(false);
    }
  }
  if (!confirming) {
    return <button type="button" className="btn !px-3 !py-1 text-xs !text-red-300" onClick={() => setConfirming(true)}>Release</button>;
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-red-300">Release {rider.name} back to freelance?</span>
      <button type="button" className="btn !border-red-800 !px-3 !py-1 !text-red-300" disabled={busy} onClick={() => void detach()}>{busy ? "Releasing…" : "Confirm"}</button>
      <button type="button" className="btn !px-3 !py-1" onClick={() => { setConfirming(false); setError(null); }}>Keep</button>
      {error ? <span className="text-red-400">{error}</span> : null}
    </span>
  );
}

export function LogisticsPortal(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(STORAGE_KEY));
  const [error, setError] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [hasStaffAccess, setHasStaffAccess] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [riders, setRiders] = useState<FleetRider[] | null>(null);
  const [chattingWith, setChattingWith] = useState<string | null>(null);
  const [viewingJobsFor, setViewingJobsFor] = useState<string | null>(null);
  const [showOwnerChat, setShowOwnerChat] = useState(false);
  const navigate = useNavigate();
  const { refresh: refreshStaffSession } = useAuth();

  function signOut() {
    sessionStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setRiders(null);
    setCompanyName(null);
  }

  const loadDashboard = useCallback(async (tok: string) => {
    try {
      const [me, ridersRes] = await Promise.all([
        portalFetch<{ logisticsCompany: { name: string }; hasStaffAccess: boolean }>(API.logisticsPortal.me, { headers: { authorization: `Bearer ${tok}` } }),
        portalFetch<{ riders: FleetRider[] }>(API.logisticsPortal.riders, { headers: { authorization: `Bearer ${tok}` } }),
      ]);
      setCompanyName(me.logisticsCompany.name);
      setHasStaffAccess(me.hasStaffAccess);
      setRiders(ridersRes.riders);
    } catch (err) {
      if (err instanceof PortalError && err.status === 401) {
        signOut();
      } else {
        setError(err instanceof PortalError ? err.message : "Could not load your fleet dashboard");
      }
    }
  }, []);

  useEffect(() => {
    if (token) void loadDashboard(token);
  }, [token, loadDashboard]);

  async function switchToStaff() {
    if (!token) return;
    setSwitching(true);
    try {
      const body = await portalFetch<{ accessToken: string }>(API.logisticsPortal.switchToStaff, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      setAccessToken(body.accessToken);
      await refreshStaffSession();
      navigate("/");
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not switch workspace");
    } finally {
      setSwitching(false);
    }
  }

  // One shared sign-in for everyone — this page is a destination, not its
  // own login, same rule as merchant-portal.tsx.
  if (!token) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{companyName ?? "Your fleet"}</h1>
          <p className="text-sm text-zinc-400">Your bearers — add your own below, or ask Platform Admin to attach existing couriers.</p>
        </div>
        <div className="flex gap-2">
          {hasStaffAccess ? (
            <button className="btn !px-3 !py-1 text-xs" disabled={switching} onClick={() => void switchToStaff()}>
              {switching ? "Switching…" : "Switch to staff dashboard"}
            </button>
          ) : null}
          <button className="btn !px-3 !py-1 text-xs" onClick={() => setShowOwnerChat((v) => !v)}>
            {showOwnerChat ? "Hide messages" : "Message Platform Admin"}
          </button>
          <button className="btn !px-3 !py-1 text-xs" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {showOwnerChat ? (
        <section className="card">
          <PlatformChat
            queryKey={`logistics-owner-${token}`}
            fetchMessages={() => portalFetch<PlatformMessagesDto>(API.logisticsPortal.ownerMessages, { headers: { authorization: `Bearer ${token}` } })}
            sendMessage={(body) => portalFetch<PlatformMessagesDto>(API.logisticsPortal.ownerMessages, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ body }) })}
          />
        </section>
      ) : null}

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <AddFleetRider token={token} onAdded={() => token && void loadDashboard(token)} />
      {riders === null ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      {riders && riders.length === 0 ? (
        <div className="card text-sm text-zinc-400">No couriers yet — add your own bearers above. They start pending: the business approves the membership, Platform Admin vets the person.</div>
      ) : null}
      <div className="space-y-2">
        {riders?.map((r) => (
          <div key={r.id} className={`card space-y-2 ${r.active ? "" : "opacity-60"}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{r.name}</p>
                <p className="text-xs text-zinc-500">{r.phone} · {r.vehicle} · {r.activeJobCount}/{r.dailyCapacity} active jobs</p>
              </div>
              <div className="flex items-center gap-2">
                {!r.active ? <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-500">Disabled</span> : null}
                <span className="flex items-center gap-1.5 rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300">
                  <span className={`h-2 w-2 rounded-full ${STATUS_DOT[r.status] ?? "bg-zinc-600"}`} />
                  {STATUS_LABEL[r.status] ?? r.status}
                </span>
                <button type="button" className="btn !px-3 !py-1 text-xs" onClick={() => setViewingJobsFor(viewingJobsFor === r.id ? null : r.id)}>
                  {viewingJobsFor === r.id ? "Hide deliveries" : "Deliveries"}
                </button>
                <button type="button" className="btn !px-3 !py-1 text-xs" onClick={() => setChattingWith(chattingWith === r.id ? null : r.id)}>
                  {chattingWith === r.id ? "Hide chat" : "Message"}
                </button>
                <DetachFleetRider token={token} rider={r} onChanged={() => token && void loadDashboard(token)} />
              </div>
            </div>
            {viewingJobsFor === r.id && token ? <RiderJobsPanel token={token} riderId={r.id} /> : null}
            {chattingWith === r.id ? (
              <PlatformChat
                queryKey={`fleet-${r.id}`}
                fetchMessages={() => portalFetch<PlatformMessagesDto>(API.logisticsPortal.riderMessages(r.id), { headers: { authorization: `Bearer ${token}` } })}
                sendMessage={(body) => portalFetch<PlatformMessagesDto>(API.logisticsPortal.riderMessages(r.id), { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ body }) })}
              />
            ) : null}
          </div>
        ))}
      </div>

      <OpenJobsSection token={token} />

      <DeleteAccountPanel
        onDelete={async (password) => {
          await portalFetch(API.accountDeletion.logisticsPortal, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ password }) });
        }}
        onDeleted={signOut}
      />
    </div>
  );
}

interface OpenJob {
  id: string; jobNumber: string | null; itemSummary: string | null;
  zoneName: string | null; merchantName: string | null; paymentMethod: string;
  createdAt: string;
}

interface AssignCandidate {
  id: string; name: string; vehicle: string; dailyCapacity: number;
  verified: boolean; activeJobCount: number; phone?: string;
}

/**
 * Unassigned work this company can fill, with one honest dialog per job:
 * YOUR fleet riders get direct-assigned; OPEN-POOL couriers get offered
 * (they choose by accepting — the company never force-assigns a
 * stranger). Narrow job rows by design: no customer identity.
 */
function OpenJobsSection({ token }: { token: string | null }): React.JSX.Element {
  const [jobs, setJobs] = useState<OpenJob[] | null>(null);
  const [couriers, setCouriers] = useState<{ fleet: AssignCandidate[]; pool: AssignCandidate[] } | null>(null);
  const [assigning, setAssigning] = useState<OpenJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    if (!token) return;
    try {
      const [j, c] = await Promise.all([
        portalFetch<{ jobs: OpenJob[] }>(API.logisticsPortal.openJobs, { headers: { authorization: `Bearer ${token}` } }),
        portalFetch<{ fleet: AssignCandidate[]; pool: AssignCandidate[] }>(API.logisticsPortal.assignCouriers, { headers: { authorization: `Bearer ${token}` } }),
      ]);
      setJobs(j.jobs);
      setCouriers(c);
      setError(null);
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not load open jobs");
    }
  }

  useEffect(() => {
    void reload();
  }, [token]);

  if (!token) return <></>;

  return (
    <section className="card space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Open jobs to fill</h2>
        <button type="button" className="btn !px-3 !py-1 text-xs" onClick={() => void reload()}>Refresh</button>
      </div>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      {jobs === null ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      {jobs && jobs.length === 0 ? <p className="text-sm text-zinc-500">Nothing unassigned right now.</p> : null}
      <div className="space-y-2">
        {jobs?.map((j) => (
          <div key={j.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 p-2 text-sm">
            <div>
              <p className="font-medium">{j.jobNumber ?? j.id.slice(0, 8)} · {j.itemSummary ?? "No item details"}</p>
              <p className="text-xs text-zinc-500">
                {j.merchantName ? `${j.merchantName} · ` : ""}{j.zoneName ?? "No zone"} · {j.paymentMethod === "cod" ? "Cash on delivery" : "Prepaid"}
              </p>
            </div>
            <button type="button" className="btn !px-3 !py-1 text-xs" onClick={() => setAssigning(j)}>Assign…</button>
          </div>
        ))}
      </div>
      {assigning && couriers ? (
        <AssignDialog
          token={token}
          job={assigning}
          fleet={couriers.fleet}
          pool={couriers.pool}
          onClose={() => setAssigning(null)}
          onDone={() => { setAssigning(null); void reload(); }}
        />
      ) : null}
    </section>
  );
}

function AssignDialog({ token, job, fleet, pool, onClose, onDone }: {
  token: string; job: OpenJob; fleet: AssignCandidate[]; pool: AssignCandidate[]; onClose: () => void; onDone: () => void;
}): React.JSX.Element {
  const [riderId, setRiderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = [...fleet, ...pool].find((r) => r.id === riderId) ?? null;
  const fromPool = pool.some((r) => r.id === riderId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!riderId) return;
    setError(null);
    setBusy(true);
    try {
      if (fromPool) {
        await portalFetch(API.logisticsPortal.offerJob(job.id), {
          method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ riderId }),
        });
      } else {
        await portalFetch(API.logisticsPortal.assignJob(job.id), {
          method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ riderId }),
        });
      }
      onDone();
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Could not send this job");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" role="dialog" aria-modal="true" aria-label={`Assign ${job.jobNumber ?? "job"}`} onClick={onClose}>
      <form onSubmit={(e) => void submit(e)} className="max-h-[85vh] w-full max-w-md space-y-3 overflow-y-auto rounded-t-2xl bg-zinc-900 p-4 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold">Send {job.jobNumber ?? "job"} to a courier</h3>
        <div>
          <label className="label" htmlFor="assign-rider">Courier</label>
          <select id="assign-rider" className="input" value={riderId} onChange={(e) => setRiderId(e.target.value)} required>
            <option value="">Choose…</option>
            <optgroup label="Your fleet — assigned directly">
              {fleet.map((r) => (
                <option key={r.id} value={r.id}>{r.name} · {r.activeJobCount}/{r.dailyCapacity} active{r.verified ? "" : " (not cash-verified)"}</option>
              ))}
            </optgroup>
            <optgroup label="Open pool — offered, they choose">
              {pool.map((r) => (
                <option key={r.id} value={r.id}>{r.name} · {r.activeJobCount}/{r.dailyCapacity} active{r.verified ? "" : " (prepaid only)"}</option>
              ))}
            </optgroup>
          </select>
        </div>
        {selected && job.paymentMethod === "cod" && !selected.verified ? (
          <p className="text-xs text-amber-400">Cash job — {selected.name} isn&apos;t cash-verified, so this will be refused. Pick a verified courier.</p>
        ) : null}
        {fromPool ? (
          <p className="text-xs text-zinc-500">Pool couriers are offered, not assigned — {selected?.name ?? "they"} accept in their own app if they want the job.</p>
        ) : null}
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <div className="flex gap-2">
          <button className="btn-accent flex-1 !py-2.5" disabled={busy || !riderId}>{busy ? "Sending…" : fromPool ? "Send offer" : "Assign now"}</button>
          <button type="button" className="btn !py-2.5" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
