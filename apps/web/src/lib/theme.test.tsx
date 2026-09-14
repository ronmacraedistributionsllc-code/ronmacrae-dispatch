import { beforeEach, describe, expect, it } from "vitest";
import { getTheme, setTheme } from "./theme.js";

describe("theme persistence", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      clear: () => values.clear(),
    } });
    window.localStorage.clear();
    document.documentElement.dataset.theme = "";
  });

  it("defaults to Ronmacrae Blue and applies the selected theme", () => {
    expect(getTheme()).toBe("ronmacrae");
    setTheme("midnight-gold");
    expect(getTheme()).toBe("midnight-gold");
    expect(document.documentElement.dataset.theme).toBe("midnight-gold");
  });

  it("rejects an unknown persisted theme", () => {
    window.localStorage.setItem("ronmacrae-theme", "unknown");
    expect(getTheme()).toBe("ronmacrae");
  });
});
