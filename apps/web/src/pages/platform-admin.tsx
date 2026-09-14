import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API } from "@ronmacrae/contracts";
import type { PlatformMessagesDto, PlatformMessageThreadDto } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";
import { PlatformChat } from "../components/platform-chat.js";

/**
 * The platform-owner console (spec: "search, inspect, approve, block,
 * disable, archive, reactivate, and manage every registered business and
 * person"). Gated by `platformRole: "owner"` — see platform-admin.ts on
 * the API side for exactly what's real here vs. explicitly not built yet
 * (ratings, admin-to-anyone messaging, per-person dispute rollups).
 */

interface BusinessRow { id: string; name: string; slug: string | null; active: boolean; merchantCount: number; staffCount: number; riderCount: number; jobCount: number; createdAt: string }
interface MerchantRow { id: string; name: string; slug: string; active: boolean; business: { id: string; name: string }; jobCount: number; productCount: number; staffCount: number; createdAt: string }
interface LogisticsCompanyRow { id: string; name: string; slug: string; active: boolean; business: { id: string; name: string }; riderCount: number; staffCount: number; createdAt: string }
type RiderAttachment = "freelance" | "merchant" | "logistics";
interface RiderRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  vehicle: string;
  active: boolean;
  platformStatus: "pending" | "approved" | "suspended";
  status: string;
  attachment: RiderAttachment;
  attachedMerchant: { id: string; name: string } | null;
  attachedLogisticsCompany: { id: string; name: string } | null;
  memberships: { businessId: string; businessName: string; status: string }[];
  merchants: { merchantId: string; merchantName: string; status: string; addedAt: string }[];
  createdAt: string;
}
interface RiderDetail extends RiderRow {
  email: string | null;
  emailVerified: boolean;
  loginActive: boolean | null;
  jobsByStatus: Record<string, number>;
  cashByBusiness: { businessId: string; businessName: string }[];
}interface StaffRow { id: string; name: string; email: string | null; phone: string | null; active: boolean; platformRole: string | null; businesses: { id: string; name: string; role: string; active: boolean }[]; merchants: { id: string; name: string; active: boolean }[]; createdAt: string }
interface AuditRow { id: string; userName: string | null; userEmail: string | null; role: string | null; action: string; entityType: string; entityId: string | null; createdAt: string }

type Tab = "businesses" | "merchants" | "logistics" | "riders" | "staff" | "messages" | "audit";

export function PlatformAdmin(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("businesses");
  const TABS: { key: Tab; label: string }[] = [
    { key: "businesses", label: "Businesses" },
    { key: "merchants", label: "Merchants" },
    { key: "logistics", label: "Logistics" },
    { key: "riders", label: "Couriers" },
    { key: "staff", label: "Staff" },
    { key: "messages", label: "Messages" },
    { key: "audit", label: "Audit log" },
  ];
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Platform Admin</h1>
        <p className="text-sm text-zinc-400">Every business, merchant, courier, and staff account on the platform.</p>
      </header>
      <div className="flex gap-1 border-b border-zinc-800">
        {TABS.map((t) => (
          <button key={t.key} className={`px-3 py-2 text-sm font-medium ${tab === t.key ? "border-b-2 border-brand-accent text-brand-accent" : "text-zinc-400"}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "businesses" ? <BusinessesTab /> : null}
      {tab === "merchants" ? <MerchantsTab /> : null}
      {tab === "logistics" ? <LogisticsTab /> : null}
      {tab === "riders" ? <RidersTab /> : null}
      {tab === "staff" ? <StaffTab /> : null}
      {tab === "messages" ? <MessagesTab /> : null}
      {tab === "audit" ? <AuditTab /> : null}
    </div>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element {
  return <input className="input max-w-xs" placeholder="Search…" value={value} onChange={(e) => onChange(e.target.value)} />;
}

function StatusPill({ active, activeLabel = "Active", inactiveLabel = "Disabled" }: { active: boolean; activeLabel?: string; inactiveLabel?: string }): React.JSX.Element {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${active ? "bg-emerald-900/50 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>
      {active ? activeLabel : inactiveLabel}
    </span>
  );
}

function BusinessesTab(): React.JSX.Element {
  const [q, setQ] = useState("");
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["platform", "businesses", q], queryFn: () => apiFetch<{ businesses: BusinessRow[] }>(`${API.platform.businesses}?q=${encodeURIComponent(q)}`) });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => apiFetch(API.platform.updateBusiness(id), { method: "PATCH", body: JSON.stringify({ active }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["platform", "businesses"] }),
  });
  return (
    <div className="space-y-3">
      <SearchBox value={q} onChange={setQ} />
      {list.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      <div className="space-y-2">
        {list.data?.businesses.map((b) => (
          <div key={b.id} className="card flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium">{b.name}</p>
              <p className="text-xs text-zinc-500">{b.merchantCount} merchants · {b.staffCount} staff · {b.riderCount} couriers · {b.jobCount} orders</p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill active={b.active} />
              <button className="btn !px-3 !py-1 text-xs" disabled={toggle.isPending} onClick={() => void toggle.mutate({ id: b.id, active: !b.active })}>
                {b.active ? "Disable" : "Reactivate"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MerchantsTab(): React.JSX.Element {
  const [q, setQ] = useState("");
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["platform", "merchants", q], queryFn: () => apiFetch<{ merchants: MerchantRow[] }>(`${API.platform.merchants}?q=${encodeURIComponent(q)}`) });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => apiFetch(API.platform.updateMerchant(id), { method: "PATCH", body: JSON.stringify({ active }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["platform", "merchants"] }),
  });
  return (
    <div className="space-y-3">
      <SearchBox value={q} onChange={setQ} />
      {list.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      <div className="space-y-2">
        {list.data?.merchants.map((m) => (
          <div key={m.id} className="card flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium">{m.name} <span className="text-xs text-zinc-500">· {m.business.name}</span></p>
              <p className="text-xs text-zinc-500">{m.jobCount} orders · {m.productCount} products · {m.staffCount} portal logins</p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill active={m.active} />
              <button className="btn !px-3 !py-1 text-xs" disabled={toggle.isPending} onClick={() => void toggle.mutate({ id: m.id, active: !m.active })}>
                {m.active ? "Disable" : "Reactivate"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LogisticsTab(): React.JSX.Element {
  const [q, setQ] = useState("");
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["platform", "logistics-companies", q], queryFn: () => apiFetch<{ logisticsCompanies: LogisticsCompanyRow[] }>(`${API.platform.logisticsCompanies}?q=${encodeURIComponent(q)}`) });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => apiFetch(API.platform.updateLogisticsCompany(id), { method: "PATCH", body: JSON.stringify({ active }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["platform", "logistics-companies"] }),
  });
  return (
    <div className="space-y-3">
      <SearchBox value={q} onChange={setQ} />
      {list.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      <div className="space-y-2">
        {list.data?.logisticsCompanies.map((c) => (
          <div key={c.id} className="card flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium">{c.name} <span className="text-xs text-zinc-500">· {c.business.name}</span></p>
              <p className="text-xs text-zinc-500">{c.riderCount} attached couriers · {c.staffCount} portal logins</p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill active={c.active} />
              <button className="btn !px-3 !py-1 text-xs" disabled={toggle.isPending} onClick={() => void toggle.mutate({ id: c.id, active: !c.active })}>
                {c.active ? "Disable" : "Reactivate"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RidersTab(): React.JSX.Element {
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["platform", "riders", q], queryFn: () => apiFetch<{ riders: RiderRow[] }>(`${API.platform.riders}?q=${encodeURIComponent(q)}`) });
  // For the attachment picker below — every merchant/logistics company on
  // the platform, not just the rider's own business (an owner can attach
  // any rider to any of them).
  const merchants = useQuery({ queryKey: ["platform", "merchants", ""], queryFn: () => apiFetch<{ merchants: MerchantRow[] }>(API.platform.merchants) });
  const companies = useQuery({ queryKey: ["platform", "logistics-companies", ""], queryFn: () => apiFetch<{ logisticsCompanies: LogisticsCompanyRow[] }>(API.platform.logisticsCompanies) });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; platformStatus?: string; active?: boolean; attachment?: RiderAttachment; attachedMerchantId?: string; attachedLogisticsCompanyId?: string }) =>
      apiFetch(API.platform.updateRider(id), { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["platform", "riders"] });
      void qc.invalidateQueries({ queryKey: ["platform", "rider"] });
    },
    onError: (err) => window.alert(err instanceof ApiError ? err.message : "Could not update this courier"),
  });
  const merchantAssign = useMutation({
    mutationFn: ({ riderId, merchantId, action }: { riderId: string; merchantId: string; action: "assign" | "remove" }) =>
      action === "assign"
        ? apiFetch(API.platform.assignRiderToMerchant(riderId), { method: "POST", body: JSON.stringify({ merchantId }) })
        : apiFetch(API.platform.removeRiderFromMerchant(riderId, merchantId), { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["platform", "riders"] });
      void qc.invalidateQueries({ queryKey: ["platform", "rider"] });
    },
    onError: (err) => window.alert(err instanceof ApiError ? err.message : "Could not update merchant assignment"),
  });
  return (
    <div className="space-y-3">
      <SearchBox value={q} onChange={setQ} />
      {list.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      <div className="space-y-2">
        {list.data?.riders.map((r) => (
          <div key={r.id} className="card space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button className="text-left font-medium underline decoration-dotted" onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                {r.name}
              </button>
              <div className="flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${r.platformStatus === "approved" ? "bg-emerald-900/50 text-emerald-300" : r.platformStatus === "suspended" ? "bg-red-900/50 text-red-300" : "bg-amber-900/50 text-amber-300"}`}>
                  {r.platformStatus}
                </span>
                <StatusPill active={r.active} />
              </div>
            </div>
            <p className="text-xs text-zinc-500">{r.phone}{r.email ? ` · ${r.email}` : ""} · {r.vehicle} · member of {r.memberships.map((m) => m.businessName).join(", ") || "no business yet"}</p>
            <div className="flex flex-wrap gap-2">
              {r.platformStatus !== "approved" ? (
                <button className="btn !px-3 !py-1 text-xs !border-emerald-700 !text-emerald-300" disabled={update.isPending} onClick={() => void update.mutate({ id: r.id, platformStatus: "approved" })}>
                  Approve for platform
                </button>
              ) : null}
              {r.platformStatus !== "suspended" ? (
                <button className="btn !px-3 !py-1 text-xs !border-red-800 !text-red-300" disabled={update.isPending} onClick={() => void update.mutate({ id: r.id, platformStatus: "suspended" })}>
                  Suspend
                </button>
              ) : null}
              <button className="btn !px-3 !py-1 text-xs" disabled={update.isPending} onClick={() => void update.mutate({ id: r.id, active: !r.active })}>
                {r.active ? "Disable login" : "Re-enable login"}
              </button>
            </div>
            <AttachmentControl
              rider={r}
              merchants={merchants.data?.merchants ?? []}
              logisticsCompanies={companies.data?.logisticsCompanies ?? []}
              busy={update.isPending}
              onChange={(body) => void update.mutate({ id: r.id, ...body })}
            />
            <MerchantAssignment
              rider={r}
              merchants={merchants.data?.merchants ?? []}
              busy={merchantAssign.isPending}
              onAssign={(merchantId) => void merchantAssign.mutate({ riderId: r.id, merchantId, action: "assign" })}
              onRemove={(merchantId) => void merchantAssign.mutate({ riderId: r.id, merchantId, action: "remove" })}
            />
            {openId === r.id ? <RiderDetailPanel id={r.id} /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Spec: "Platform Admin controls whether a rider is: freelancer/
 *  platform-approved... attached only to one merchant; attached to one
 *  logistics/bearer company." A plain select rather than a form — picking
 *  "Merchant"/"Logistics" immediately shows the matching target picker,
 *  and choosing a target fires the update right away (no separate Save,
 *  matching the rest of this tab's one-click controls). */
function AttachmentControl({
  rider,
  merchants,
  logisticsCompanies,
  busy,
  onChange,
}: {
  rider: RiderRow;
  merchants: MerchantRow[];
  logisticsCompanies: LogisticsCompanyRow[];
  busy: boolean;
  onChange: (body: { attachment: RiderAttachment; attachedMerchantId?: string; attachedLogisticsCompanyId?: string }) => void;
}): React.JSX.Element {
  const [pending, setPending] = useState<RiderAttachment | null>(null);
  const mode = pending ?? rider.attachment;

  function setMode(next: RiderAttachment) {
    setPending(next);
    if (next === "freelance") onChange({ attachment: "freelance" });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 p-2 text-xs">
      <span className="text-zinc-500">Attachment:</span>
      <select className="input !w-auto !py-1 text-xs" value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as RiderAttachment)}>
        <option value="freelance">Freelance (unrestricted)</option>
        <option value="merchant">One merchant</option>
        <option value="logistics">One logistics company</option>
      </select>
      {mode === "merchant" ? (
        <select
          className="input !w-auto !py-1 text-xs"
          disabled={busy}
          defaultValue={rider.attachedMerchant?.id ?? ""}
          onChange={(e) => e.target.value && onChange({ attachment: "merchant", attachedMerchantId: e.target.value })}
        >
          <option value="" disabled>Choose a merchant…</option>
          {merchants.map((m) => (
            <option key={m.id} value={m.id}>{m.name} · {m.business.name}</option>
          ))}
        </select>
      ) : null}
      {mode === "logistics" ? (
        <select
          className="input !w-auto !py-1 text-xs"
          disabled={busy}
          defaultValue={rider.attachedLogisticsCompany?.id ?? ""}
          onChange={(e) => e.target.value && onChange({ attachment: "logistics", attachedLogisticsCompanyId: e.target.value })}
        >
          <option value="" disabled>Choose a logistics company…</option>
          {logisticsCompanies.map((c) => (
            <option key={c.id} value={c.id}>{c.name} · {c.business.name}</option>
          ))}
        </select>
      ) : null}
      {rider.attachment === "merchant" && rider.attachedMerchant ? <span className="text-zinc-500">currently: {rider.attachedMerchant.name}</span> : null}
      {rider.attachment === "logistics" && rider.attachedLogisticsCompany ? <span className="text-zinc-500">currently: {rider.attachedLogisticsCompany.name}</span> : null}
    </div>
  );
}

/** Spec: one rider can belong to more than one merchant. The many-to-many
 *  MerchantRider relationship is managed here (assign to any merchant,
 *  remove from one) — separate from AttachmentControl above, which is the
 *  single-merchant *eligibility* gate. */
function MerchantAssignment({
  rider,
  merchants,
  busy,
  onAssign,
  onRemove,
}: {
  rider: RiderRow;
  merchants: MerchantRow[];
  busy: boolean;
  onAssign: (merchantId: string) => void;
  onRemove: (merchantId: string) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState("");
  const attached = rider.merchants ?? [];
  const available = merchants.filter((m) => !attached.some((a) => a.merchantId === m.id));
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 p-2 text-xs">
      <p className="text-zinc-500">Merchants:</p>
      {attached.length === 0 ? <p className="text-zinc-600">Not attached to any merchant yet.</p> : null}
      {attached.map((a) => (
        <div key={a.merchantId} className="flex items-center justify-between gap-2">
          <span>{a.merchantName}</span>
          <button className="btn !px-2 !py-0.5 text-xs !border-red-800 !text-red-300" disabled={busy} onClick={() => onRemove(a.merchantId)}>
            Remove
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <select className="input !w-auto !py-1 text-xs" value={selected} disabled={busy} onChange={(e) => setSelected(e.target.value)}>
          <option value="" disabled>Assign to merchant…</option>
          {available.map((m) => (
            <option key={m.id} value={m.id}>{m.name} · {m.business.name}</option>
          ))}
        </select>
        <button
          className="btn !px-2 !py-0.5 text-xs"
          disabled={busy || !selected}
          onClick={() => {
            onAssign(selected);
            setSelected("");
          }}
        >
          Assign
        </button>
      </div>
    </div>
  );
}

interface RatingsSummary {
  average: number | null;
  count: number;
  recent: { id: string; jobId: string; raterType: "customer" | "merchant"; score: number; comment: string | null; createdAt: string }[];
}

function RiderDetailPanel({ id }: { id: string }): React.JSX.Element {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["platform", "rider", id], queryFn: () => apiFetch<{ rider: RiderDetail; ratings: RatingsSummary }>(API.platform.rider(id)) });
  const moderate = useMutation({
    mutationFn: ({ ratingId, hidden }: { ratingId: string; hidden: boolean }) => apiFetch(API.platform.moderateRating(ratingId), { method: "PATCH", body: JSON.stringify({ hidden }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["platform", "rider", id] }),
  });
  if (detail.isLoading) return <p className="text-xs text-zinc-500">Loading detail…</p>;
  if (!detail.data) return <p className="text-xs text-red-400">Could not load detail.</p>;
  const { rider, ratings } = detail.data;
  return (
    <div className="rounded-lg border border-zinc-700 p-3 text-sm space-y-2">
      <p className="text-zinc-400">Email: {rider.email ?? "—"} {rider.email ? (rider.emailVerified ? "(verified)" : "(not verified)") : ""}</p>
      <p className="text-zinc-400">
        Jobs by status: {Object.keys(rider.jobsByStatus).length === 0 ? "none yet" : Object.entries(rider.jobsByStatus).map(([s, c]) => `${s}: ${c}`).join(", ")}
      </p>
      <p className="text-zinc-400">Businesses: {rider.memberships.map((m) => `${m.businessName} (${m.status})`).join(", ") || "none"}</p>
      <div>
        <p className="text-zinc-400">
          Rating: {ratings.count === 0 ? "no ratings yet" : `${ratings.average?.toFixed(1)} ★ (${ratings.count} rating${ratings.count === 1 ? "" : "s"})`}
        </p>
        {ratings.recent.length > 0 ? (
          <ul className="mt-1 space-y-1">
            {ratings.recent.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-xs text-zinc-500">
                <span>{"★".repeat(r.score)} ({r.raterType}){r.comment ? ` — ${r.comment}` : ""}</span>
                <button className="btn !px-2 !py-0.5 text-xs" disabled={moderate.isPending} onClick={() => void moderate.mutate({ ratingId: r.id, hidden: true })}>
                  Hide
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function StaffTab(): React.JSX.Element {
  const [q, setQ] = useState("");
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["platform", "staff", q], queryFn: () => apiFetch<{ staff: StaffRow[] }>(`${API.platform.staff}?q=${encodeURIComponent(q)}`) });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => apiFetch(API.platform.updateUser(id), { method: "PATCH", body: JSON.stringify({ active }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["platform", "staff"] }),
    onError: (err) => window.alert(err instanceof ApiError ? err.message : "Could not update this account"),
  });
  return (
    <div className="space-y-3">
      <SearchBox value={q} onChange={setQ} />
      {list.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      <div className="space-y-2">
        {list.data?.staff.map((u) => (
          <div key={u.id} className="card flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium">{u.name} {u.platformRole === "owner" ? <span className="text-xs text-amber-400">(platform owner)</span> : null}</p>
              <p className="text-xs text-zinc-500">
                {u.email ?? u.phone ?? "—"} ·{" "}
                {[...u.businesses.map((b) => `${b.name} (${b.role})`), ...u.merchants.map((m) => `${m.name} (merchant)`)].join(", ") || "no access yet"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill active={u.active} />
              <button className="btn !px-3 !py-1 text-xs" disabled={toggle.isPending} onClick={() => void toggle.mutate({ id: u.id, active: !u.active })}>
                {u.active ? "Disable" : "Reactivate"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Spec: "admin-to-anyone" — every user who has messaged in, most recent
 *  first, with the open thread's own chat below. A shared team inbox: any
 *  owner sees and can reply to any thread, not just ones they started. */
function MessagesTab(): React.JSX.Element {
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["platform", "messages", "threads"], queryFn: () => apiFetch<{ threads: PlatformMessageThreadDto[] }>(API.platformMessages.threads), refetchInterval: 20_000 });
  const threads = [...(list.data?.threads ?? [])].sort((a, b) => (b.lastMessage?.createdAt ?? "").localeCompare(a.lastMessage?.createdAt ?? ""));

  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className="space-y-2">
        {list.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
        {threads.length === 0 ? <p className="text-sm text-zinc-500">No one has messaged in yet.</p> : null}
        {threads.map((t) => (
          <button
            key={t.userId}
            type="button"
            className={`card block w-full text-left ${openUserId === t.userId ? "!border-brand-accent" : ""}`}
            onClick={() => setOpenUserId(t.userId)}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">{t.userName}</p>
              {t.unreadCount > 0 ? <span className="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{t.unreadCount}</span> : null}
            </div>
            {t.lastMessage ? <p className="truncate text-xs text-zinc-500">{t.lastMessage.senderRole === "owner" ? "You: " : ""}{t.lastMessage.body}</p> : null}
          </button>
        ))}
      </div>
      <div>
        {openUserId ? (
          <section className="card">
            <PlatformChat
              queryKey={`platform-owner-${openUserId}`}
              fetchMessages={() => apiFetch<PlatformMessagesDto>(API.platformMessages.thread(openUserId))}
              sendMessage={(body) => apiFetch<PlatformMessagesDto>(API.platformMessages.thread(openUserId), { method: "POST", body: JSON.stringify({ body }) })}
            />
          </section>
        ) : (
          <p className="text-sm text-zinc-500">Choose a conversation to open it.</p>
        )}
      </div>
    </div>
  );
}

function AuditTab(): React.JSX.Element {
  const [action, setAction] = useState("");
  const list = useQuery({ queryKey: ["platform", "audit", action], queryFn: () => apiFetch<{ logs: AuditRow[]; total: number }>(`${API.platform.audit}?action=${encodeURIComponent(action)}`) });
  return (
    <div className="space-y-3">
      <input className="input max-w-xs" placeholder="Filter by action (e.g. platform.rider)" value={action} onChange={(e) => setAction(e.target.value)} />
      {list.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="py-1 pr-3">When</th>
              <th className="py-1 pr-3">Who</th>
              <th className="py-1 pr-3">Action</th>
              <th className="py-1 pr-3">Entity</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.logs.map((l) => (
              <tr key={l.id} className="border-t border-zinc-800">
                <td className="py-1.5 pr-3 text-zinc-400">{new Date(l.createdAt).toLocaleString()}</td>
                <td className="py-1.5 pr-3">{l.userName ?? l.userEmail ?? "—"} <span className="text-zinc-500">({l.role ?? "—"})</span></td>
                <td className="py-1.5 pr-3">{l.action}</td>
                <td className="py-1.5 pr-3 text-zinc-500">{l.entityType}{l.entityId ? ` · ${l.entityId.slice(0, 8)}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
