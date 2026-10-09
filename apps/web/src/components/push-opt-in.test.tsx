import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PushOptIn } from "./push-opt-in.js";

const authState: { role: string | null } = { role: null };

vi.mock("../lib/auth.js", () => ({
  useAuth: () => ({ user: authState.role ? { role: authState.role } : null }),
}));

vi.mock("../native/push.js", () => ({
  getNativePushStatus: vi.fn(),
  enableNativePush: vi.fn(),
  disableNativePush: vi.fn(),
}));

async function pushAdapter() {
  return (await import("../native/push.js")) as unknown as {
    getNativePushStatus: ReturnType<typeof vi.fn>;
    enableNativePush: ReturnType<typeof vi.fn>;
    disableNativePush: ReturnType<typeof vi.fn>;
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
  authState.role = null;
});

afterEach(() => {
  setNative(false);
});

describe("PushOptIn native gating", () => {
  it("non-native: takes the untouched web path and never touches the native adapter", async () => {
    setNative(false);
    authState.role = "rider";
    const { container } = render(<PushOptIn />);
    const adapter = await pushAdapter();
    expect(adapter.getNativePushStatus).not.toHaveBeenCalled();
    // jsdom has no serviceWorker/PushManager, so the pre-existing web path
    // renders nothing here — exactly what it did before this change.
    expect(container.innerHTML).toBe("");
  });

  it("native + rider: shows the native toggle, enable flows through the adapter", async () => {
    setNative(true);
    authState.role = "rider";
    const adapter = await pushAdapter();
    adapter.getNativePushStatus.mockResolvedValue("off");
    adapter.enableNativePush.mockResolvedValue("on");

    render(<PushOptIn />);
    expect(await screen.findByText(/Allow notifications so new delivery offers wake your phone/)).toBeTruthy();
    fireEvent.click(screen.getByText("Enable push notifications"));
    await waitFor(() => expect(adapter.enableNativePush).toHaveBeenCalled());
    expect(await screen.findByText("Disable push notifications")).toBeTruthy();
  });

  it("native + non-rider: shows neither the native toggle nor the web one", async () => {
    setNative(true);
    authState.role = "dispatcher";
    const { container } = render(<PushOptIn />);
    const adapter = await pushAdapter();
    await waitFor(() => expect(adapter.getNativePushStatus).not.toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
