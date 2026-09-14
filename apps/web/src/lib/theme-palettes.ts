import type { ThemeId } from "./theme.js";

/**
 * Swatch-only mirror of styles.css's `[data-theme="..."]` CSS custom
 * properties (base hex, alpha channels dropped) — used purely for the
 * theme-preview page's side-by-side comparison cards. Necessarily
 * duplicated rather than read live from the DOM: this app's CSS applies
 * exactly one theme at a time to `:root`, so several themes can't be
 * rendered simultaneously from CSS variables alone. If a color here and
 * styles.css's own value for the same theme ever drift, styles.css is the
 * real, applied truth — this is a preview aid, not the source of it.
 */
export const THEME_PALETTES: Record<ThemeId, { bg: string; panel: string; accent: string; fg: string; fgMuted: string; border: string }> = {
  ronmacrae: { bg: "#09090b", panel: "#18181b", accent: "#f2b705", fg: "#f4f4f5", fgMuted: "#a1a1aa", border: "#27272a" },
  "ronmacrae-blue": { bg: "#060a1a", panel: "#0d1638", accent: "#5aa9ff", fg: "#f5f8ff", fgMuted: "#a9bbf0", border: "#1f2e64" },
  "midnight-gold": { bg: "#100d08", panel: "#231b0e", accent: "#f2b705", fg: "#fff7df", fgMuted: "#d9c58f", border: "#5a421d" },
  "clean-light": { bg: "#f5f7fb", panel: "#ffffff", accent: "#c88a04", fg: "#172033", fgMuted: "#3f4a5f", border: "#d8dfeb" },
  "night-courier": { bg: "#07151a", panel: "#092327", accent: "#f2b705", fg: "#e2fbf4", fgMuted: "#a3d6cd", border: "#174e52" },
  jamaica: { bg: "#060a07", panel: "#0d1e14", accent: "#f7c948", fg: "#eafff2", fgMuted: "#a7d7b7", border: "#1f5c3a" },
};

export const THEME_DESCRIPTIONS: Record<ThemeId, string> = {
  ronmacrae: "The original look — unchanged, and still the default for every new account.",
  "ronmacrae-blue": "Deep navy, electric blue, white. Crisp and corporate.",
  "midnight-gold": "Charcoal and black with a warm gold accent.",
  "clean-light": "White and soft grey with a blue-leaning accent — the one light theme.",
  "night-courier": "Dark slate with a glowing neon-blue-green edge.",
  jamaica: "Black, green, and gold — bonus, not one of the four requested, kept because it already shipped and works well.",
};
