import React, { useState } from "react";
import { THEMES, chooseTheme, getTheme, type ThemeId } from "../lib/theme.js";
import { THEME_DESCRIPTIONS, THEME_PALETTES } from "../lib/theme-palettes.js";

/**
 * Stage E (spec: "Provide a visual preview/selection screen... for me to
 * choose a future default"). Each card renders a small mock of the app's
 * own chrome (header, card, buttons) in that theme's real colors, so this
 * is a genuine preview, not just a swatch list — see theme-palettes.ts's
 * own doc comment for why these are separate, hand-kept hex values rather
 * than read live from CSS (this app applies one theme to the whole
 * document at a time, so several can't render from CSS variables at once).
 * Picking a card applies and persists it immediately — the same
 * `chooseTheme` every other switcher in the app calls — so this page
 * doubles as the full switcher, not just a look.
 */
export function ThemePreview(): React.JSX.Element {
  const [active, setActive] = useState<ThemeId>(getTheme);

  function pick(id: ThemeId) {
    chooseTheme(id);
    setActive(id);
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Choose a theme</h1>
        <p className="text-sm text-zinc-400">
          Applies everywhere immediately — cards, forms, tables, alerts, and every portal. Your current default (the
          original look) stays exactly as it is unless you pick something else here.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {THEMES.map((t) => (
          <ThemeCard key={t.id} id={t.id} label={t.label} isActive={active === t.id} onPick={() => pick(t.id)} />
        ))}
      </div>
    </div>
  );
}

function ThemeCard({ id, label, isActive, onPick }: { id: ThemeId; label: string; isActive: boolean; onPick: () => void }): React.JSX.Element {
  const p = THEME_PALETTES[id];
  return (
    <div
      className="overflow-hidden rounded-xl border-2 transition"
      style={{ borderColor: isActive ? p.accent : "transparent", background: "var(--theme-panel)" }}
    >
      {/* Mock app chrome, rendered in this theme's own real colors regardless of the page's current theme. */}
      <div style={{ background: p.bg, padding: "0.9rem" }}>
        <div className="mb-2 flex items-center justify-between">
          <span style={{ color: p.accent, fontWeight: 700, fontSize: "0.8rem" }}>Ronmacrae</span>
          <span style={{ color: p.fgMuted, fontSize: "0.65rem" }}>Dispatch</span>
        </div>
        <div className="space-y-1.5 rounded-lg p-2.5" style={{ background: p.panel, border: `1px solid ${p.border}` }}>
          <div className="flex items-center justify-between">
            <span style={{ color: p.fg, fontSize: "0.7rem", fontWeight: 600 }}>RM-000482</span>
            <span className="rounded px-1.5 py-0.5" style={{ background: p.border, color: p.fgMuted, fontSize: "0.6rem" }}>assigned</span>
          </div>
          <p style={{ color: p.fgMuted, fontSize: "0.62rem" }}>3 Constant Spring Rd → Half Way Tree</p>
          <button
            type="button"
            className="mt-1 rounded px-2 py-1 text-[0.62rem] font-semibold"
            style={{ background: p.accent, color: p.bg }}
            onClick={(e) => e.preventDefault()}
            tabIndex={-1}
          >
            Assign courier
          </button>
        </div>
      </div>
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-100">{label}</h2>
          {isActive ? <span className="rounded-full bg-emerald-900/50 px-2 py-0.5 text-[10px] font-medium text-emerald-300">Active</span> : null}
        </div>
        <p className="text-xs text-zinc-400">{THEME_DESCRIPTIONS[id]}</p>
        <div className="flex gap-1.5">
          {[p.bg, p.panel, p.accent, p.fg].map((c, i) => (
            <span key={i} className="h-4 w-4 rounded-full border border-zinc-700" style={{ background: c }} />
          ))}
        </div>
        <button
          type="button"
          className={isActive ? "btn w-full !py-1.5 text-xs" : "btn-accent w-full !py-1.5 text-xs"}
          disabled={isActive}
          onClick={onPick}
        >
          {isActive ? "Currently active" : "Use this theme"}
        </button>
      </div>
    </div>
  );
}
