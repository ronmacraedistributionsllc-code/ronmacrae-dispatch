import React from "react";
import { API } from "@ronmacrae/contracts";
import type { PlatformMessagesDto } from "@ronmacrae/contracts";
import { apiFetch } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { PlatformChat } from "../components/platform-chat.js";

/**
 * "Message the owner" (spec: "admin-to-anyone") — available to any signed-in
 * staff or rider, same shared access token, same API.messages.owner path
 * whichever role is signed in. A Platform Admin's own side of every one of
 * these threads is platform-admin.tsx's Messages tab.
 */
export function Messages(): React.JSX.Element {
  const { user } = useAuth();
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <header>
        <h1 className="text-xl font-bold">Message the owner</h1>
        <p className="text-sm text-zinc-400">A direct line to Platform Admin — {user?.name ?? "you"} and the platform owner only.</p>
      </header>
      <section className="card">
        <PlatformChat
          queryKey="owner"
          fetchMessages={() => apiFetch<PlatformMessagesDto>(API.messages.owner)}
          sendMessage={(body) => apiFetch<PlatformMessagesDto>(API.messages.owner, { method: "POST", body: JSON.stringify({ body }) })}
        />
      </section>
    </div>
  );
}
