import { describe, expect, it, afterEach } from "vitest";
import { isNative, isNativeRider, nativePlatform } from "./platform.js";

function clearCapacitor(): void {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
}

afterEach(() => {
  clearCapacitor();
});

describe("native platform detection", () => {
  it("is not native on plain web (no injected runtime)", () => {
    clearCapacitor();
    expect(isNative()).toBe(false);
    expect(nativePlatform()).toBe("web");
    expect(isNativeRider("rider")).toBe(false);
  });

  it("detects the injected shell runtime without importing @capacitor/core", () => {
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    };
    expect(isNative()).toBe(true);
    expect(nativePlatform()).toBe("android");
  });

  it("gates native behaviour on the rider role, not just the shell", () => {
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    };
    expect(isNativeRider("rider")).toBe(true);
    expect(isNativeRider("dispatcher")).toBe(false);
    expect(isNativeRider("admin")).toBe(false);
    expect(isNativeRider(null)).toBe(false);
    expect(isNativeRider(undefined)).toBe(false);
  });

  it("treats a web-platform runtime as non-native", () => {
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => false,
      getPlatform: () => "web",
    };
    expect(isNative()).toBe(false);
    expect(isNativeRider("rider")).toBe(false);
  });
});
