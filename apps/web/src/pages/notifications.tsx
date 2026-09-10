import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { API } from "@ronmacrae/contracts";
import type { NotificationStatus, NotificationTemplateDto, OutboxMessageDto } from "@ronmacrae/contracts";

interface ProviderStatus {
  provider: string;
  channels: string[];
}

const STATUS_LABEL: Record<NotificationStatus, string> = {
  queued: "Pending",
  sending: "Pending",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  suppressed: "Skipped",
};
const STATUS_BADGE: Record<NotificationStatus, string> = {
  queued: "bg-zinc-800 text-zinc-300",
  sending: "bg-zinc-800 text-zinc-300",
  sent: "bg-sky-900/50 text-sky-300",
  delivered: "bg-emerald-900/50 text-emerald-300",
  failed: "bg-red-900/50 text-red-300",
  suppressed: "bg-zinc-800 text-zinc-500",
};

export function Notifications(): React.JSX.Element {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [showTemplates, setShowTemplates] = useState(false);

  const messages = useQuery({
    queryKey: ["notifications-all"],
    queryFn: () => apiFetch<{ messages: OutboxMessageDto[]; provider: string }>(`${API.notifications.list}?take=100`),
    refetchInterval: 15_000,
  });
  const provider = useQuery({
    queryKey: ["notification-provider"],
    queryFn: () => apiFetch<ProviderStatus>(API.notifications.status),
    retry: false,
  });
  const retry = useMutation({
    mutationFn: (id: string) => apiFetch(API.notifications.retry(id), { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications-all"] }),
  });

  const isPreview = provider.data?.provider === "memory";

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Notifications</h1>
          <p className="text-sm text-zinc-400">Customer outbox log — every automatic delivery-status message, and whether it actually went out.</p>
        </div>
        <div className="flex items-center gap-2">
          {provider.data ? (
            <span className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">
              provider: {provider.data.provider} ({provider.data.channels.join(", ")})
            </span>
          ) : null}
          <button className="btn !px-3 !py-1 text-xs" onClick={() => setShowTemplates((v) => !v)}>
            {showTemplates ? "Hide templates" : "Message templates"}
          </button>
        </div>
      </header>

      {isPreview ? (
        <section className="card border-amber-800/50 bg-amber-950/10">
          <p className="text-sm text-amber-200">
            <strong>Preview mode.</strong> No real WhatsApp/SMS provider is connected — messages below are logged and
            marked as if sent, but nothing actually leaves this server. To connect a real provider later (not done
            here — no live credentials or billing is enabled): set <code>NOTIFICATION_PROVIDER=twilio</code> plus
            Twilio account credentials, and point that account's status-callback URL at{" "}
            <code>/api/notifications/twilio-status</code> so delivery confirmations flow back in — otherwise every
            message would sit at "Sent" forever, since a provider accepting a message isn't the same as it being
            delivered.
          </p>
        </section>
      ) : null}

      {showTemplates ? <TemplatesEditor canEdit={user?.role === "admin"} /> : null}

      <section className="card overflow-x-auto">
        {messages.data && messages.data.messages.length > 0 ? (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-1 pr-4">Status</th>
                <th className="py-1 pr-4">Channel</th>
                <th className="py-1 pr-4">To</th>
                <th className="py-1 pr-4">Template</th>
                <th className="py-1 pr-4">Attempts</th>
                <th className="py-1 pr-4">When</th>
                {user?.role === "admin" || user?.role === "dispatcher" ? <th className="py-1">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {messages.data.messages.map((m) => (
                <tr key={m.id} className="border-t border-zinc-800">
                  <td className="py-2 pr-4">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[m.status]}`}>{STATUS_LABEL[m.status]}</span>
                    {m.error ? <p className="mt-1 max-w-52 truncate text-xs text-red-400" title={m.error}>{m.error}</p> : null}
                  </td>
                  <td className="py-2 pr-4">{m.channel}</td>
                  <td className="py-2 pr-4">{m.to}</td>
                  <td className="py-2 pr-4">{m.template}</td>
                  <td className="py-2 pr-4">{m.attempts}</td>
                  <td className="py-2 pr-4 text-zinc-400">
                    {new Date(m.createdAt).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                  </td>
                  {user?.role === "admin" || user?.role === "dispatcher" ? (
                    <td className="py-2">
                      {m.status === "failed" ? (
                        <button className="btn !px-2 !py-0.5 text-xs" disabled={retry.isPending} onClick={() => retry.mutate(m.id)}>
                          Retry
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-zinc-500">
            Nothing in the outbox yet. Customer messages are queued automatically as an order is placed and as jobs
            change state (only for customers who've consented to tracking messages).
          </p>
        )}
      </section>
    </div>
  );
}

function TemplatesEditor({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const templates = useQuery({
    queryKey: ["notification-templates"],
    queryFn: () => apiFetch<{ templates: NotificationTemplateDto[] }>(API.notifications.templates),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, string>) => apiFetch(API.notifications.templates, { method: "PUT", body: JSON.stringify({ templates: body }) }),
    onSuccess: () => {
      setDrafts({});
      void qc.invalidateQueries({ queryKey: ["notification-templates"] });
    },
  });

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Message templates</h2>
        <p className="text-xs text-zinc-500">
          The exact wording sent for each of the 8 lifecycle events. Placeholders like <code>{"{{trackingUrl}}"}</code>{" "}
          are filled in automatically — don't remove the ones already in a template, or that information won't appear.
        </p>
      </div>
      {templates.isLoading ? <p className="text-sm text-zinc-500">Loading…</p> : null}
      {save.error ? <p className="text-sm text-red-400">Could not save — check for a typo in a placeholder or template name.</p> : null}
      <div className="space-y-3">
        {templates.data?.templates.map((t) => {
          const draft = drafts[t.name] ?? t.body;
          const dirty = draft !== t.body;
          return (
            <div key={t.name} className="rounded-lg border border-zinc-700 p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-200">{t.name.replaceAll("_", " ")}</span>
                {t.overridden ? <span className="rounded bg-sky-900/50 px-2 py-0.5 text-xs text-sky-300">customized</span> : null}
              </div>
              <textarea
                className="input min-h-16 w-full font-mono text-xs"
                value={draft}
                disabled={!canEdit}
                onChange={(e) => setDrafts((d) => ({ ...d, [t.name]: e.target.value }))}
              />
              {canEdit && dirty ? (
                <div className="mt-2 flex gap-2">
                  <button className="btn-accent !px-3 !py-1 text-xs" disabled={save.isPending} onClick={() => save.mutate({ [t.name]: draft })}>
                    Save
                  </button>
                  <button className="btn !px-3 !py-1 text-xs" onClick={() => setDrafts((d) => { const next = { ...d }; delete next[t.name]; return next; })}>
                    Revert
                  </button>
                </div>
              ) : null}
              {canEdit && !dirty && t.overridden ? (
                <button className="btn mt-2 !px-3 !py-1 text-xs" disabled={save.isPending} onClick={() => save.mutate({ [t.name]: "" })}>
                  Reset to default
                </button>
              ) : null}
              {!canEdit ? <p className="mt-1 text-xs text-zinc-600">Only an owner/admin can edit templates.</p> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
