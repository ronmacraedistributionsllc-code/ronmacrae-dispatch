import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API, STAFF_ROLES } from "@ronmacrae/contracts";
import type { RiderDto, Role, StaffRole, UserDto } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  dispatcher: "Dispatcher",
  accountant: "Accountant",
  viewer: "Viewer",
  rider: "Rider",
};

/**
 * Staff + rider account creation — the backend for both (`POST /api/users`,
 * `POST /api/riders`) already existed, but no screen ever called either one:
 * an admin had no way to actually create a working dispatcher or rider
 * login except through raw API calls. This is that screen.
 */
export function Team(): React.JSX.Element {
  const { user } = useAuth();
  const canEdit = user?.role === "admin";
  const qc = useQueryClient();
  const [addingStaff, setAddingStaff] = useState(false);
  const [addingRider, setAddingRider] = useState(false);

  const staff = useQuery({ queryKey: ["users"], queryFn: () => apiFetch<{ users: UserDto[] }>(API.users.list) });
  const riders = useQuery({ queryKey: ["riders"], queryFn: () => apiFetch<{ riders: RiderDto[] }>(API.riders.list) });
  const pending = useQuery({ queryKey: ["riders", "pending"], queryFn: () => apiFetch<{ riders: RiderDto[] }>(API.riders.pending) });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => apiFetch(API.riders.decide(id), { method: "POST", body: JSON.stringify({ approve }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["riders"] });
      void qc.invalidateQueries({ queryKey: ["riders", "pending"] });
    },
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">Team</h1>
        <p className="text-sm text-zinc-400">Staff logins (dispatcher, accountant, viewer, admin) and rider accounts.</p>
      </header>

      {canEdit && pending.data && pending.data.riders.length > 0 ? (
        <section className="space-y-3">
          <h2 className="font-semibold text-amber-400">🔔 Pending rider applications ({pending.data.riders.length})</h2>
          <div className="space-y-2">
            {pending.data.riders.map((r) => (
              <div key={r.id} className="card flex flex-wrap items-center justify-between gap-2 border-amber-800/40">
                <div>
                  <p className="font-medium">{r.name}</p>
                  <p className="text-xs text-zinc-500">{r.phone} · {r.vehicle}{r.plate ? ` · ${r.plate}` : ""}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn !px-3 !py-1 text-xs !border-emerald-700 !text-emerald-300" disabled={decide.isPending} onClick={() => void decide.mutate({ id: r.id, approve: true })}>
                    Approve
                  </button>
                  <button type="button" className="btn !px-3 !py-1 text-xs !border-red-800 !text-red-300" disabled={decide.isPending} onClick={() => void decide.mutate({ id: r.id, approve: false })}>
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">Staff</h2>
          {canEdit ? (
            <button className="btn-accent" onClick={() => setAddingStaff((v) => !v)}>{addingStaff ? "Cancel" : "+ Add staff"}</button>
          ) : null}
        </div>
        {addingStaff ? (
          <CreateStaffForm onDone={() => { setAddingStaff(false); void qc.invalidateQueries({ queryKey: ["users"] }); }} />
        ) : null}
        {staff.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
        <div className="space-y-2">
          {staff.data?.users.filter((u) => u.role !== "rider").map((u) => (
            <div key={u.id} className="card flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{u.name}</p>
                <p className="text-xs text-zinc-500">{u.email ?? u.phone ?? "—"}</p>
              </div>
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${u.active ? "bg-emerald-900/50 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>
                {ROLE_LABEL[u.role]}{u.active ? "" : " · disabled"}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">Riders</h2>
          {canEdit ? (
            <button className="btn-accent" onClick={() => setAddingRider((v) => !v)}>{addingRider ? "Cancel" : "+ Add rider"}</button>
          ) : null}
        </div>
        {addingRider ? (
          <CreateRiderForm onDone={() => { setAddingRider(false); void qc.invalidateQueries({ queryKey: ["riders"] }); }} />
        ) : null}
        {riders.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
        {riders.data && riders.data.riders.length === 0 ? (
          <div className="card text-sm text-zinc-400">No riders yet — add one so jobs can actually be assigned and delivered.</div>
        ) : null}
        <div className="space-y-2">
          {riders.data?.riders.map((r) => (
            <div key={r.id} className="card flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{r.name}</p>
                <p className="text-xs text-zinc-500">{r.phone} · {r.vehicle}</p>
              </div>
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${r.active ? "bg-emerald-900/50 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>
                {r.status}{r.active ? "" : " · disabled"}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function CreateStaffForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<StaffRole>("dispatcher");
  const create = useMutation({
    mutationFn: () => apiFetch(API.users.create, { method: "POST", body: JSON.stringify({ name, email: email || undefined, phone: phone || undefined, password, role }) }),
    onSuccess: onDone,
  });
  const canSubmit = name.trim().length > 0 && (email.trim().length > 0 || phone.trim().length > 0) && password.length >= 8;
  return (
    <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); void create.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="s-name">Full name</label>
          <input id="s-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="s-role">Role</label>
          <select id="s-role" className="input" value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
            {STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="s-email">Email (or phone below)</label>
          <input id="s-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="s-phone">Phone (optional if email given)</label>
          <input id="s-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="876 555 1234" />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="s-password">Temporary password (at least 8 characters)</label>
          <input id="s-password" className="input" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="mt-1 text-xs text-zinc-500">Share this with them directly — there's no email invite yet, so hand it over yourself.</p>
        </div>
      </div>
      {create.error ? <p className="text-sm text-red-400">{create.error instanceof ApiError ? create.error.message : "Could not create this account"}</p> : null}
      <button className="btn-accent" disabled={create.isPending || !canSubmit}>{create.isPending ? "Creating…" : "Create staff login"}</button>
    </form>
  );
}

function CreateRiderForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [vehicle, setVehicle] = useState<"motorcycle" | "car">("motorcycle");
  const [password, setPassword] = useState("");
  const create = useMutation({
    mutationFn: () => apiFetch(API.riders.create, { method: "POST", body: JSON.stringify({ name, phone, email: email || undefined, vehicle, password: password || undefined }) }),
    onSuccess: onDone,
  });
  const canSubmit = name.trim().length > 0 && phone.replace(/[^\d]/g, "").length >= 7;
  return (
    <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); void create.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="r-name">Full name</label>
          <input id="r-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="r-phone">Phone</label>
          <input id="r-phone" className="input" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="876 555 1234" />
        </div>
        <div>
          <label className="label" htmlFor="r-email">Email (needed for them to log in)</label>
          <input id="r-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="r-vehicle">Vehicle</label>
          <select id="r-vehicle" className="input" value={vehicle} onChange={(e) => setVehicle(e.target.value as "motorcycle" | "car")}>
            <option value="motorcycle">Motorcycle</option>
            <option value="car">Car</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="r-password">Login password (optional — leave blank if they'll only use the phone app link)</label>
          <input id="r-password" className="input" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </div>
      {create.error ? <p className="text-sm text-red-400">{create.error instanceof ApiError ? create.error.message : "Could not create this rider"}</p> : null}
      <button className="btn-accent" disabled={create.isPending || !canSubmit}>{create.isPending ? "Creating…" : "Add rider"}</button>
    </form>
  );
}
