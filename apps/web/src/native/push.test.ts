import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  __resetNativePushForTests,
  disableNativePush,
  enableNativePush,
  getNativePushStatus,
  NATIVE_CHANNEL_ACTIVE_DELIVERY,
  NATIVE_CHANNEL_JOB_OFFERS,
  NATIVE_CHANNEL_MESSAGES,
} from "./push.js";

const listeners: Record<string, (arg: unknown) => void> = {};

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: {
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    register: vi.fn(),
    removeAllListeners: vi.fn(),
    addListener: vi.fn((event: string, cb: (arg: unknown) => void) => {
      listeners[event] = cb;
      return Promise.resolve({ remove: vi.fn() });
    }),
  },
}));

vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    createChannel: vi.fn(() => Promise.resolve()),
  },
}));

async function pushPlugin() {
  return (await import("@capacitor/push-notifications")).PushNotifications as unknown as {
    checkPermissions: ReturnType<typeof vi.fn>;
    requestPermissions: ReturnType<typeof vi.fn>;
    register: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
  };
}

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
  for (const k of Object.keys(listeners)) delete listeners[k];
  __resetNativePushForTests();
});

afterEach(() => {
  setNative(false);
});

describe("native push adapter", () => {
  it("reports unsupported outside the shell without touching the plugins", async () => {
    setNative(false);
    expect(await getNativePushStatus()).toBe("unsupported");
    expect(await enableNativePush(() => {})).toBe("unsupported");
    const plugin = await pushPlugin();
    expect(plugin.checkPermissions).not.toHaveBeenCalled();
  });

  it("reports denied when the OS permission was denied", async () => {
    setNative(true);
    const plugin = await pushPlugin();
    plugin.checkPermissions.mockResolvedValue({ receive: "denied" });
    expect(await getNativePushStatus()).toBe("denied");
  });

  it("enables: explains nothing itself, creates channels, registers, forwards the token", async () => {
    setNative(true);
    const plugin = await pushPlugin();
    plugin.checkPermissions.mockResolvedValue({ receive: "prompt" });
    // After the user grants, the OS reports granted from then on.
    plugin.requestPermissions.mockImplementation(() => {
      plugin.checkPermissions.mockResolvedValue({ receive: "granted" });
      return Promise.resolve({ receive: "granted" });
    });
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    const onToken = vi.fn();

    // Simulate FCM delivering the token right after register().
    plugin.register.mockImplementation(() => {
      listeners["registration"]?.({ value: "fcm-token-1" });
      return Promise.resolve();
    });

    expect(await enableNativePush(onToken)).toBe("on");
    expect(LocalNotifications.createChannel).toHaveBeenCalledTimes(3);
    const ids = (LocalNotifications.createChannel as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].id);
    expect(ids).toEqual([NATIVE_CHANNEL_JOB_OFFERS, NATIVE_CHANNEL_ACTIVE_DELIVERY, NATIVE_CHANNEL_MESSAGES]);
    expect(plugin.register).toHaveBeenCalled();
    expect(onToken).toHaveBeenCalledWith("fcm-token-1");
    // Permission now granted and this session registered.
    expect(await getNativePushStatus()).toBe("on");
  });

  it("disable tears down listeners and never throws", async () => {
    setNative(true);
    const plugin = await pushPlugin();
    await disableNativePush();
    expect(plugin.removeAllListeners).toHaveBeenCalled();
    setNative(false);
    await expect(disableNativePush()).resolves.toBeUndefined();
  });
});
