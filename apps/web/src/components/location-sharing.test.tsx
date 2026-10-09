import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LocationSharing } from "./location-sharing.js";

const authState: { role: string | null } = { role: null };

vi.mock("../lib/auth.js", () => ({
  useAuth: () => ({ user: authState.role ? { role: authState.role } : null }),
}));

vi.mock("../native/location.js", () => ({
  isNativeSharing: vi.fn(() => false),
  startNativeSharing: vi.fn(),
  stopNativeSharing: vi.fn(),
}));

async function locationAdapter() {
  return (await import("../native/location.js")) as unknown as {
    isNativeSharing: ReturnType<typeof vi.fn>;
    startNativeSharing: ReturnType<typeof vi.fn>;
    stopNativeSharing: ReturnType<typeof vi.fn>;
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

describe("LocationSharing native gating", () => {
  it("non-native: renders the untouched foreground path", () => {
    setNative(false);
    authState.role = "rider";
    render(<LocationSharing riderId="r1" />);
    // The pre-existing button copy is unchanged — byte-for-byte behaviour.
    expect(screen.getByText("Share my location")).toBeTruthy();
  });

  it("native + rider: shows the native path with the screen-off disclosure, start uses the watcher", async () => {
    setNative(true);
    authState.role = "rider";
    const adapter = await locationAdapter();
    adapter.startNativeSharing.mockResolvedValue("sharing");
    render(<LocationSharing riderId="r1" />);
    expect(screen.getByText(/even with the screen off/)).toBeTruthy();
    fireEvent.click(screen.getByText("Share my location"));
    expect(adapter.startNativeSharing).toHaveBeenCalled();
  });

  it("native + non-rider: renders nothing", async () => {
    setNative(true);
    authState.role = "dispatcher";
    const { container } = render(<LocationSharing riderId="r1" />);
    const adapter = await locationAdapter();
    expect(adapter.startNativeSharing).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });
});
