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
  if (user?.platformRole !== "owner" || businessId) return null;
  return (
    <p className="card border border-amber-800/40 text-xs text-amber-200">
      You&apos;re signed in as the platform owner (no business workspace), so {what} here would just fail.
      Manage it in <a className="underline" href="/platform-admin">Platform Admin</a> instead — every delete lives there too.
    </p>
  );
}
