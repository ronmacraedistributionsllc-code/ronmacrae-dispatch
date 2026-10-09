import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  __resetNativeSharingForTests,
  isNativeSharing,
  startNativeSharing,
  stopNativeSharing,
} from "./location.js";

const geo = {
  addWatcher: vi.fn(),
  removeWatcher: vi.fn(() => Promise.resolve()),
};

vi.mock("@capacitor/core", () => ({
  registerPlugin: vi.fn(() => geo),
}));

function setNative(native: boolean): void {
  if (native) {
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    };
  } else {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetNativeSharingForTests();
});

afterEach(() => {
  setNative(false);
});

describe("native location adapter", () => {
  it("is unsupported outside the shell without touching the plugin", async () => {
    setNative(false);
    const onPoint = vi.fn();
    expect(await startNativeSharing({ onPoint, onError: () => {}, foregroundTitle: "t", foregroundMessage: "m" })).toBe(
      "unsupported",
    );
    expect(geo.addWatcher).not.toHaveBeenCalled();
    expect(isNativeSharing()).toBe(false);
  });

  it("starts a watcher and forwards points as lat/lng", async () => {
    setNative(true);
    const box: {
      cb?: (loc?: { latitude: number; longitude: number; time: number | null }, err?: Error) => void;
    } = {};
    geo.addWatcher.mockImplementation(
      (
        _opts: unknown,
        cb: (loc?: { latitude: number; longitude: number; time: number | null }, err?: Error) => void,
      ) => {
        box.cb = cb;
        return Promise.resolve("watcher-1");
      },
    );
    const onPoint = vi.fn();
    const onError = vi.fn();

    expect(
      await startNativeSharing({ onPoint, onError, foregroundTitle: "Sharing", foregroundMessage: "Stop anytime" }),
    ).toBe("sharing");
    expect(isNativeSharing()).toBe(true);
    const firstCall = geo.addWatcher.mock.calls[0];
    if (!firstCall) throw new Error("expected addWatcher to be called");
    const opts = firstCall[0] as { backgroundMessage: string; stale: boolean };
    expect(opts.backgroundMessage).toContain("Stop anytime");
    expect(opts.stale).toBe(false);

    box.cb?.({ latitude: 18.0, longitude: -76.8, time: 123 });
    expect(onPoint).toHaveBeenCalledWith({ lat: 18.0, lng: -76.8, time: 123 });
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces plugin errors to onError instead of throwing", async () => {
    setNative(true);
    const box: { cb?: (loc?: unknown, err?: Error) => void } = {};
    geo.addWatcher.mockImplementation((_: unknown, cb: (loc?: unknown, err?: Error) => void) => {
      box.cb = cb;
      return Promise.resolve("watcher-2");
    });
    const onPoint = vi.fn();
    const onError = vi.fn();
    await startNativeSharing({ onPoint, onError, foregroundTitle: "t", foregroundMessage: "m" });
    box.cb?.(undefined, new Error("gps off"));
    expect(onPoint).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("gps off");
  });

  it("maps denied permission to permission-denied", async () => {
    setNative(true);
    const err = new Error("NOT_AUTHORIZED") as Error & { code: string };
    err.code = "NOT_AUTHORIZED";
    geo.addWatcher.mockRejectedValue(err);
    expect(
      await startNativeSharing({ onPoint: () => {}, onError: () => {}, foregroundTitle: "t", foregroundMessage: "m" }),
    ).toBe("permission-denied");
    expect(isNativeSharing()).toBe(false);
  });

  it("stop removes the watcher by id and is safe to repeat", async () => {
    setNative(true);
    geo.addWatcher.mockResolvedValue("watcher-9");
    await startNativeSharing({ onPoint: () => {}, onError: () => {}, foregroundTitle: "t", foregroundMessage: "m" });
    await stopNativeSharing();
    expect(geo.removeWatcher).toHaveBeenCalledWith({ id: "watcher-9" });
    expect(isNativeSharing()).toBe(false);
    await expect(stopNativeSharing()).resolves.toBeUndefined();
  });
});
