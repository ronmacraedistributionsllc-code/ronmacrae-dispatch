import type React from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api.js";
import type { OutboxMessageDto } from "@ronmacrae/contracts";

interface ProviderStatus {
  provider: string;
  channels: string[];
}

export function Notifications(): React.JSX.Element {
  const messages = useQuery({
    queryKey: ["notifications-all"],
    queryFn: () => apiFetch<{ messages: OutboxMessageDto[] }>("/notifications?take=100"),
    refetchInterval: 15_000,
  });
  const provider = useQuery({
    queryKey: ["notification-provider"],
    queryFn: () => apiFetch<ProviderStatus>("/notifications/provider"),
    retry: false,
  });

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold">Notifications</h1>
          <p className="text-sm text-zinc-400">Customer outbox log</p>
        </div>
        {provider.data ? (
          <span className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">
            provider: {provider.data.provider} ({provider.data.channels.join(", ")})
          </span>
        ) : null}
      </header>

      <section className="card">
        {messages.data && messages.data.messages.length > 0 ? (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-1 pr-4">Status</th>
                <th className="py-1 pr-4">Channel</th>
                <th className="py-1 pr-4">To</th>
                <th className="py-1 pr-4">Template</th>
                <th className="py-1 pr-4">Attempts</th>
                <th className="py-1">When</th>
              </tr>
            </thead>
            <tbody>
              {messages.data.messages.map((m) => (
                <tr key={m.id} className="border-t border-zinc-800">
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        m.status === "delivered"
                          ? "bg-emerald-900/50 text-emerald-300"
                          : m.status === "failed"
                            ? "bg-red-900/50 text-red-300"
                            : "bg-zinc-800 text-zinc-300"
                      }`}
                    >
                      {m.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4">{m.channel}</td>
                  <td className="py-2 pr-4">{m.to}</td>
                  <td className="py-2 pr-4">{m.template}</td>
                  <td className="py-2 pr-4">{m.attempts}</td>
                  <td className="py-2 text-zinc-400">
                    {new Date(m.createdAt).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-zinc-500">
            Nothing in the outbox yet. Customer messages are queued as jobs change state (preview mode logs them
            instead of sending).
          </p>
        )}
      </section>
    </div>
  );
}
