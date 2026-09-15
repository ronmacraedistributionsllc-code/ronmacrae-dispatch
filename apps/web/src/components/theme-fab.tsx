import React, { useEffect, useRef, useState } from "react";
import { THEMES, chooseTheme, getTheme, type ThemeId } from "../lib/theme.js";

/** A recognizable swatch per theme — not a live preview (switching
 *  data-theme just to render a thumbnail would repaint the whole app
 *  behind the popover), just enough colour to tell them apart at a glance. */
const SWATCH: Record<ThemeId, string> = {
  ronmacrae: "linear-gradient(135deg, #123f2e, #f2b705)",
  "ronmacrae-blue": "linear-gradient(135deg, #14275c, #5aa9ff)",
  "midnight-gold": "linear-gradient(135deg, #1c140a, #f2b705)",
  "clean-light": "linear-gradient(135deg, #f5f7fb, #c88a04)",
  "night-courier": "linear-gradient(135deg, #07151a, #f2b705)",
  jamaica: "linear-gradient(135deg, #14682f, #f7c948)",
  "sunset-reef": "linear-gradient(135deg, #1a0b2e, #9c2c5c, #ff7a45)",
};

/**
 * The one control every screen gets for changing appearance (spec: "just
 * give me a button all the way at the bottom to change theme") — a
 * persistent, fixed-position floating button rather than a form field
 * buried in Settings, so it's reachable from wherever someone actually is.
 * Doesn't touch what the default theme itself looks like — same THEMES
 * list and chooseTheme() every other theme picker (login's own compact
 * select, the full Settings form) already uses, just a different, more
 * prominent way to reach it.
 */
export function ThemeFab(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<ThemeId>(getTheme);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(id: ThemeId) {
    setCurrent(id);
    chooseTheme(id);
    setOpen(false);
  }

  return (
    // bottom-20 clears the mobile bottom nav bar (its own fixed strip plus
    // safe-area inset); md:bottom-4 tucks back into the corner once that
    // bar no longer exists at desktop widths.
    <div ref={ref} className="fixed bottom-20 right-4 z-50 md:bottom-4">
      {open ? (
        <div className="mb-2 w-64 rounded-2xl border p-3 shadow-2xl" style={{ background: "var(--theme-panel)", borderColor: "var(--theme-border)", backdropFilter: "blur(16px)" }} role="menu" aria-label="Choose theme">
          <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--theme-fg-subtle)" }}>
            Appearance
          </p>
          <div className="grid grid-cols-2 gap-2">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="menuitemradio"
                aria-checked={current === t.id}
                onClick={() => pick(t.id)}
                className="flex flex-col items-start gap-1.5 rounded-xl border p-2 text-left text-xs transition hover:scale-[1.03]"
                style={{
                  borderColor: current === t.id ? "var(--theme-accent)" : "var(--theme-border)",
                  boxShadow: current === t.id ? "0 0 0 1px var(--theme-accent)" : "none",
                  color: "var(--theme-fg)",
                }}
              >
                <span className="h-6 w-full rounded-lg" style={{ backgroundImage: SWATCH[t.id] }} aria-hidden="true" />
                <span className="font-medium leading-tight">{t.label}</span>
              </button>
            ))}
          </div>
          <a href="/theme-preview" className="mt-2 block px-1 text-xs underline" style={{ color: "var(--theme-fg-subtle)" }}>
            Preview all themes full-screen →
          </a>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Change theme"
        className="flex h-12 w-12 items-center justify-center rounded-full text-xl shadow-2xl transition hover:scale-110"
        style={{ background: "var(--theme-accent)", color: "var(--theme-brand-dark)" }}
      >
        🎨
      </button>
    </div>
  );
}
