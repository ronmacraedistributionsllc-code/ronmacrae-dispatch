import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocationSharing } from "./location-sharing.js";

const authState: { role: string | null } = { role: null };

vi.mock("../lib/auth.js", () => ({
  useAuth: () => ({ user: authState.role ? { role: authState.role } : null }),
}));

vi.mock("../native/location.js", () => ({
  isNativeSharing: vi.fn(() => false),
  startNativeSharing: vi.fn(),
  stopNativeSharing: vi.fn(() => Promise.resolve()),
  wasSharingWhenClosed: vi.fn(() => Promise.resolve(false)),
  markSharingFlag: vi.fn(() => Promise.resolve()),
  batteryHintDismissed: vi.fn(() => Promise.resolve(true)),
  dismissBatteryHint: vi.fn(() => Promise.resolve()),
  openNativeLocationSettings: vi.fn(() => Promise.resolve()),
}));

async function locationAdapter() {
  return (await import("../native/location.js")) as unknown as {
    isNativeSharing: ReturnType<typeof vi.fn>;
    startNativeSharing: ReturnType<typeof vi.fn>;
    stopNativeSharing: ReturnType<typeof vi.fn>;
    wasSharingWhenClosed: ReturnType<typeof vi.fn>;
    markSharingFlag: ReturnType<typeof vi.fn>;
    batteryHintDismissed: ReturnType<typeof vi.fn>;
    dismissBatteryHint: ReturnType<typeof vi.fn>;
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

  it("native + rider with an active delivery: disclosure first, watcher only after confirm", async () => {
    setNative(true);
    authState.role = "rider";
    const adapter = await locationAdapter();
    adapter.startNativeSharing.mockResolvedValue("sharing");
    render(<LocationSharing riderId="r1" hasActiveDelivery />);
    fireEvent.click(screen.getByText("Share my location"));
    // The prominent disclosure appears BEFORE any OS prompt or watcher.
    expect(screen.getByText("Share your location in the background?")).toBeTruthy();
    expect(adapter.startNativeSharing).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("I understand — start sharing"));
    await waitFor(() => expect(adapter.startNativeSharing).toHaveBeenCalled());
    expect(await screen.findByText(/Sharing in background/)).toBeTruthy();
  });

  it("native + rider without an active delivery: sharing is unavailable, watcher never starts", () => {
    setNative(true);
    authState.role = "rider";
    render(<LocationSharing riderId="r1" hasActiveDelivery={false} />);
    expect(screen.getByText(/available while you have an active delivery/)).toBeTruthy();
    expect(screen.getByText("Share my location").closest("button")?.disabled).toBe(true);
  });

  it("delivery ending while sharing stops the watcher", async () => {
    setNative(true);
    authState.role = "rider";
    const adapter = await locationAdapter();
    adapter.startNativeSharing.mockResolvedValue("sharing");
    const { rerender } = render(<LocationSharing riderId="r1" hasActiveDelivery />);
    fireEvent.click(screen.getByText("Share my location"));
    fireEvent.click(screen.getByText("I understand — start sharing"));
    await waitFor(() => expect(adapter.startNativeSharing).toHaveBeenCalled());
    rerender(<LocationSharing riderId="r1" hasActiveDelivery={false} />);
    await waitFor(() => expect(adapter.stopNativeSharing).toHaveBeenCalled());
  });

  it("a service killed while the app was closed is reported honestly, never resumed silently", async () => {
    setNative(true);
    authState.role = "rider";
    const adapter = await locationAdapter();
    adapter.wasSharingWhenClosed.mockResolvedValue(true);
    render(<LocationSharing riderId="r1" hasActiveDelivery />);
    expect(await screen.findByText(/Sharing stopped while the app was closed/)).toBeTruthy();
    expect(adapter.startNativeSharing).not.toHaveBeenCalled();
  });

  it("the battery hint shows once until dismissed", async () => {
    setNative(true);
    authState.role = "rider";
    const adapter = await locationAdapter();
    adapter.batteryHintDismissed.mockResolvedValue(false);
    render(<LocationSharing riderId="r1" hasActiveDelivery />);
    expect(await screen.findByText("Keep location sharing alive")).toBeTruthy();
    fireEvent.click(screen.getByText("Don't show again"));
    await waitFor(() => expect(adapter.dismissBatteryHint).toHaveBeenCalled());
  });

  it("native + non-rider: renders nothing", async () => {
    setNative(true);
    authState.role = "dispatcher";
    const { container } = render(<LocationSharing riderId="r1" hasActiveDelivery />);
    const adapter = await locationAdapter();
    expect(adapter.startNativeSharing).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });
});
