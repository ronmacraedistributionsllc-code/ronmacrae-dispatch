import React from "react";
import { useAuth } from "../lib/auth.js";

/**
 * Shown on business-scoped management pages when the session has no
 * business workspace — today that means the platform owner, whose token
 * deliberately carries no businessId (see guards.ts: letting it through
 * would turn every `businessId` filter into "no filter"). Without this
 * notice, every edit button on the page looks alive but answers 403.
 * Everything here is still doable, in Platform Admin.
 */
export function OwnerNotice({ what }: { what: string }): React.JSX.Element | null {
  const { user, businessId } = useAuth();
  const platform = user?.platformRole === "owner" || user?.platformRole === "manager";
  if (!platform || businessId) return null;
  const who = user?.platformRole === "manager" ? "app manager" : "platform owner";
  return (
    <p className="card border border-amber-800/40 text-xs text-amber-200">
      You&apos;re signed in as {who} (no business workspace), so {what} here needs a business login — but
      the Delete buttons below work platform-wide regardless. <a className="underline" href="/platform-admin">Platform Admin</a> has
      everything too.
    </p>
  );
}
