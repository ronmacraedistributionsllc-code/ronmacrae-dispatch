import React from "react";

export const THEMES = [
  { id: "ronmacrae", label: "Ronmacrae Blue" },
  { id: "midnight-gold", label: "Midnight Gold" },
  { id: "clean-light", label: "Clean Light" },
  { id: "night-courier", label: "Night Courier" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
const KEY = "ronmacrae-theme";

export function getTheme(): ThemeId {
  const value = window.localStorage.getItem(KEY);
  return THEMES.some((theme) => theme.id === value) ? value as ThemeId : "ronmacrae";
}

export function setTheme(theme: ThemeId): void {
  window.localStorage.setItem(KEY, theme);
  document.documentElement.dataset.theme = theme;
}

export function ThemeSwitcher(): React.JSX.Element {
  const [theme, setSelected] = React.useState<ThemeId>(getTheme);
  return <div className="space-y-2">
    <label className="label" htmlFor="theme-select">Appearance</label>
    <select id="theme-select" className="input" value={theme} onChange={(e) => { const next = e.target.value as ThemeId; setSelected(next); setTheme(next); }}>
      {THEMES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    <p className="text-xs text-zinc-500">Saved on this device and applied across public and signed-in screens.</p>
  </div>;
}
