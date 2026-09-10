import type React from "react";

export function Spinner({ label }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-dvh items-center justify-center gap-3 text-zinc-400">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-brand-accent" />
      {label ? <span className="text-sm">{label}</span> : null}
    </div>
  );
}
