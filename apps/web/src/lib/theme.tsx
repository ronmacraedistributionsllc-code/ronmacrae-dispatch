import React from "react";
import { API } from "@ronmacrae/contracts";
import { apiFetch, getAccessToken } from "./api.js";

export const THEMES = [
  { id: "ronmacrae", label: "Ronmacrae (default)" },
  { id: "ronmacrae-blue", label: "Ronmacrae Blue" },
  { id: "midnight-gold", label: "Midnight Gold" },
  { id: "clean-light", label: "Clean Light" },
  { id: "night-courier", label: "Night Courier" },
  { id: "jamaica", label: "Jamaica" },
  { id: "sunset-reef", label: "Sunset Reef ✨" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
const KEY = "ronmacrae-theme";

export function getTheme(): ThemeId {
  const value = window.localStorage.getItem(KEY);
  return THEMES.some((theme) => theme.id === value) ? value as ThemeId : "ronmacrae";
}

/** Applies a theme to this device only — localStorage + the DOM attribute
 *  every `[data-theme="..."]` CSS block keys off. Never talks to the
 *  server; see `chooseTheme` below for the version a person actually
 *  picking a theme should call. */
export function setTheme(theme: ThemeId): void {
  window.localStorage.setItem(KEY, theme);
  document.documentElement.dataset.theme = theme;
}

/** Best-effort — localStorage already has the real answer regardless of
 *  whether this round-trip succeeds, so a network hiccup here never blocks
 *  or reverts the theme the person just picked. */
async function persistThemeRemote(theme: ThemeId): Promise<void> {
  try {
    await apiFetch(API.auth.theme, { method: "PUT", body: JSON.stringify({ theme }) });
  } catch {
    // best-effort — see doc comment above
  }
}

/** What every theme picker in the app should call — applies it to this
 *  device immediately, and, only when a real session exists (a public
 *  page like /login or /book has none), persists it server-side too, so
 *  it follows the signed-in person to their next device (spec: "persist
 *  per user"). */
export function chooseTheme(theme: ThemeId): void {
  setTheme(theme);
  if (getAccessToken()) void persistThemeRemote(theme);
}

/** Called once, right after a session loads (AuthProvider's own loadMe) —
 *  a signed-in user's saved server-side preference overrides whatever
 *  this particular device's localStorage already had, so a fresh login
 *  on a new device picks up their real preference instead of that
 *  device's own leftover default. Never re-persists what it just read —
 *  only `chooseTheme` (a person actually picking one) writes back. */
export function applyRemoteTheme(theme: string | null | undefined): void {
  if (!theme || !THEMES.some((t) => t.id === theme)) return;
  if (getTheme() === theme) return;
  setTheme(theme as ThemeId);
}

export function ThemeSwitcher(): React.JSX.Element {
  const [theme, setSelected] = React.useState<ThemeId>(getTheme);
  return <div className="space-y-2">
    <label className="label" htmlFor="theme-select">Appearance</label>
    <select id="theme-select" className="input" value={theme} onChange={(e) => { const next = e.target.value as ThemeId; setSelected(next); chooseTheme(next); }}>
      {THEMES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    <p className="text-xs text-zinc-500">
      Applied across every screen. Saved to your account if you're signed in (follows you to your next device); saved
      on this device only otherwise.
    </p>
  </div>;
}

/** Compact theme picker for embedding in footers/headers where the full
 *  Settings form doesn't belong — same persistence, same themes. */
export function CompactThemeSelect(): React.JSX.Element {
  const [theme, setSelected] = React.useState<ThemeId>(getTheme);
  return (
    <select
      aria-label="Theme"
      className="input !w-auto !py-1 text-xs"
      value={theme}
      onChange={(e) => { const next = e.target.value as ThemeId; setSelected(next); chooseTheme(next); }}
    >
      {THEMES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
  );
}
