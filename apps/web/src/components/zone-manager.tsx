import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API } from "@ronmacrae/contracts";
import type { ZoneDto } from "@ronmacrae/contracts";
import { ApiError, apiFetch, formatMoney } from "../lib/api.js";
import { AddressPicker, type ConfirmedLocation } from "./address-picker.js";

interface ZoneForm {
  name: string;
  parish: string;
  baseFee: string;
  perKmFee: string;
  urgentSurchargeFee: string;
  active: boolean;
}

const EMPTY_FORM: ZoneForm = { name: "", parish: "", baseFee: "", perKmFee: "", urgentSurchargeFee: "", active: true };

function num(raw: string): number | undefined {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Owner/admin-only delivery-fee zone management: create (from a confirmed address
 * + auto-generated coverage area), edit, enable/disable, and delete. Every write
 * route behind this UI is also enforced server-side as admin-only
 * (apps/api/src/modules/zones.ts) — this component is a convenience, not the
 * security boundary.
 */
export function ZoneManager(): React.JSX.Element {
  const qc = useQueryClient();
  const zones = useQuery({ queryKey: ["zones"], queryFn: () => apiFetch<{ zones: ZoneDto[] }>(API.zones.list) });

  const [center, setCenter] = useState<ConfirmedLocation | null>(null);
  const [form, setForm] = useState<ZoneForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<ZoneForm>) => setForm((f) => ({ ...f, ...patch }));
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["zones"] });

  const create = useMutation({
    mutationFn: () =>
      apiFetch(API.zones.create, {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          parish: form.parish.trim() || undefined,
          center: center!.point,
          baseFee: num(form.baseFee) ?? 0,
          perKmFee: num(form.perKmFee),
          urgentSurchargeFee: num(form.urgentSurchargeFee),
          active: form.active,
        }),
      }),
    onSuccess: () => {
      invalidate();
      setForm(EMPTY_FORM);
      setCenter(null);
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not create the zone"),
  });

  const update = useMutation({
    mutationFn: (id: string) =>
      apiFetch(API.zones.update(id), {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name.trim(),
          parish: form.parish.trim() || undefined,
          baseFee: num(form.baseFee),
          perKmFee: form.perKmFee.trim() === "" ? null : num(form.perKmFee),
          urgentSurchargeFee: form.urgentSurchargeFee.trim() === "" ? null : num(form.urgentSurchargeFee),
          active: form.active,
        }),
      }),
    onSuccess: () => {
      invalidate();
      setEditingId(null);
      setForm(EMPTY_FORM);
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not update the zone"),
  });

  const toggleActive = useMutation({
    mutationFn: (z: ZoneDto) => apiFetch(API.zones.update(z.id), { method: "PATCH", body: JSON.stringify({ active: !z.active }) }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(API.zones.delete(id), { method: "DELETE" }),
    onSuccess: invalidate,
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not delete the zone"),
  });

  function startEdit(z: ZoneDto): void {
    setEditingId(z.id);
    setForm({
      name: z.name,
      parish: z.parish ?? "",
      baseFee: String(z.baseFee.amount),
      perKmFee: z.perKmFee ? String(z.perKmFee.amount) : "",
      urgentSurchargeFee: z.urgentSurchargeFee ? String(z.urgentSurchargeFee.amount) : "",
      active: z.active,
    });
  }

  function cancelEdit(): void {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
  }

  const busy = create.isPending || update.isPending || toggleActive.isPending || remove.isPending;

  return (
    <section className="card space-y-4 border border-amber-800/40">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">Manage delivery-fee zones (owner only)</h2>
        <p className="text-xs text-zinc-500">Dispatchers can use these rates when booking; only an admin can create, edit, disable, or delete them.</p>
      </div>

      <div className="space-y-3 rounded-lg border border-zinc-800 p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{editingId ? "Edit zone" : "New zone"}</h3>
        {!editingId ? <AddressPicker title="Zone center (city / area)" value={center} onChange={setCenter} required /> : null}
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label" htmlFor="zm-name">
              Zone / city / area name
            </label>
            <input id="zm-name" className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Mandeville" />
          </div>
          <div>
            <label className="label" htmlFor="zm-parish">
              Parish <span className="text-zinc-500">(optional)</span>
            </label>
            <input id="zm-parish" className="input" value={form.parish} onChange={(e) => set({ parish: e.target.value })} placeholder="e.g. Manchester" />
          </div>
          <div>
            <label className="label" htmlFor="zm-base-fee">
              Delivery fee (base)
            </label>
            <input id="zm-base-fee" className="input" type="number" min={0} step="any" value={form.baseFee} onChange={(e) => set({ baseFee: e.target.value })} placeholder="e.g. 350" />
          </div>
          <div>
            <label className="label" htmlFor="zm-per-km">
              Per-km fee <span className="text-zinc-500">(optional)</span>
            </label>
            <input id="zm-per-km" className="input" type="number" min={0} step="any" value={form.perKmFee} onChange={(e) => set({ perKmFee: e.target.value })} placeholder="e.g. 50" />
          </div>
          <div>
            <label className="label" htmlFor="zm-urgent">
              Urgent surcharge <span className="text-zinc-500">(optional)</span>
            </label>
            <input
              id="zm-urgent"
              className="input"
              type="number"
              min={0}
              step="any"
              value={form.urgentSurchargeFee}
              onChange={(e) => set({ urgentSurchargeFee: e.target.value })}
              placeholder="e.g. 200"
            />
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-zinc-200">
              <input type="checkbox" checked={form.active} onChange={(e) => set({ active: e.target.checked })} />
              Active
            </label>
          </div>
        </div>
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <div className="flex gap-2">
          {editingId ? (
            <>
              <button type="button" className="btn-accent" disabled={busy || form.name.trim() === ""} onClick={() => update.mutate(editingId)}>
                {update.isPending ? "Saving…" : "Save changes"}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={cancelEdit}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="btn-accent" disabled={busy || form.name.trim() === "" || !center} onClick={() => create.mutate()}>
              {create.isPending ? "Creating…" : "Create zone"}
            </button>
          )}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Existing zones</h3>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-zinc-500">
              <th className="py-1 pr-3">Zone</th>
              <th className="py-1 pr-3">Base fee</th>
              <th className="py-1 pr-3">Per km</th>
              <th className="py-1 pr-3">Urgent surcharge</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {zones.data?.zones.map((z) => (
              <tr key={z.id} className="border-t border-zinc-800">
                <td className="py-2 pr-3 font-medium text-zinc-200">{z.name}</td>
                <td className="py-2 pr-3">{formatMoney(z.baseFee)}</td>
                <td className="py-2 pr-3">{formatMoney(z.perKmFee)}</td>
                <td className="py-2 pr-3">{formatMoney(z.urgentSurchargeFee)}</td>
                <td className="py-2 pr-3">{z.active ? "active" : "disabled"}</td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className="btn !px-2 !py-0.5 text-xs" disabled={busy} onClick={() => startEdit(z)}>
                      Edit
                    </button>
                    <button type="button" className="btn !px-2 !py-0.5 text-xs" disabled={busy} onClick={() => toggleActive.mutate(z)}>
                      {z.active ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      className="btn !px-2 !py-0.5 text-xs !text-red-400"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete zone "${z.name}"? This can't be undone.`)) remove.mutate(z.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
