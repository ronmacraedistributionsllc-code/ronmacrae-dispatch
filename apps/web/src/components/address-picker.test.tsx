import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real PinMap boots a WebGL map (maplibre-gl) which jsdom can't render.
// Stand in with a plain button that reports a fixed "drag" point — the thing
// under test here is what AddressPicker *does* with a moved pin, not the map
// widget itself (that's covered by manual/e2e testing).
vi.mock("./pin-map.js", () => ({
  PinMap: ({ onMove }: { onMove: (p: { lat: number; lng: number }) => void }) => (
    <button type="button" data-testid="drag-pin" onClick={() => onMove({ lat: 18.02, lng: -76.79 })}>
      drag pin
    </button>
  ),
}));

const apiFetchMock = vi.fn();
vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

import { AddressPicker, type ConfirmedLocation } from "./address-picker.js";

function geocodeOk(label: string, point = { lat: 18.0, lng: -76.8 }, provider = "google") {
  return { results: [{ label, point, provider }], degraded: provider === "simulated" };
}
function geocodeEmpty() {
  return { results: [], degraded: false };
}

describe("AddressPicker", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  function typeAddress(text: string) {
    const input = screen.getByPlaceholderText("Type the exact delivery address…");
    fireEvent.change(input, { target: { value: text } });
    return input as HTMLInputElement;
  }

  it("never suggests while typing — no request fires until 'Find on map' is clicked", async () => {
    const onChange = vi.fn();
    render(<AddressPicker title="Destination" value={null} onChange={onChange} />);

    typeAddress("15 cougar drive");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Cougar Drive, Meadowvale/)).toBeNull();
  });

  it("locates exactly the typed text on demand and confirms it unchanged", async () => {
    const typed = "15 cougar drive";
    apiFetchMock.mockResolvedValueOnce(geocodeOk("Cougar Drive, Meadowvale, Portmore, Jamaica"));
    const onChange = vi.fn();
    render(<AddressPicker title="Destination" value={null} onChange={onChange} />);

    const input = typeAddress(typed);
    fireEvent.click(screen.getByText("Find on map"));

    // one geocode, for exactly what was typed
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((apiFetchMock.mock.calls[0]?.[1] as { body: string }).body)).toMatchObject({ query: typed, limit: 1 });

    // the provider match is shown only as secondary info, not substituted in
    expect(await screen.findByText(/Provider match:/)).toHaveTextContent("Cougar Drive, Meadowvale, Portmore, Jamaica");
    expect(input.value).toBe(typed);

    fireEvent.click(screen.getByText("Confirm location"));
    expect(onChange).toHaveBeenCalledWith({
      address: typed,
      providerAddress: "Cougar Drive, Meadowvale, Portmore, Jamaica",
      point: { lat: 18.0, lng: -76.8 },
    } satisfies ConfirmedLocation);
  });

  it("keeps the typed address unchanged after dragging the pin (reverse geocode never overwrites it)", async () => {
    const typed = "Apt 4B, 22 Molynes Road, near the blue gate";
    apiFetchMock.mockResolvedValueOnce(geocodeOk("22 Molynes Rd, Kingston, Jamaica"));
    const onChange = vi.fn();
    render(<AddressPicker title="Destination" value={null} onChange={onChange} />);

    const input = typeAddress(typed);
    fireEvent.click(screen.getByText("Find on map"));
    await screen.findByTestId("drag-pin");

    apiFetchMock.mockResolvedValueOnce({ label: "A Completely Different Reverse-Geocoded Street" });
    fireEvent.click(screen.getByTestId("drag-pin"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(input.value).toBe(typed);
    fireEvent.click(screen.getByText("Confirm location"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ address: typed, point: { lat: 18.02, lng: -76.79 } }),
    );
  });

  it("places a draggable fallback pin when the provider finds no match", async () => {
    const typed = "Behind the yellow shop, off Windward Road, no fixed number";
    apiFetchMock.mockResolvedValueOnce(geocodeEmpty());
    const onChange = vi.fn();
    render(<AddressPicker title="Destination" value={null} onChange={onChange} />);

    const input = typeAddress(typed);
    fireEvent.click(screen.getByText("Find on map"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // typed text is untouched, and a pin (fallback point) is now placed so the flow can complete
    expect(input.value).toBe(typed);
    expect(screen.getByText("Confirm location")).toBeInTheDocument();
    expect(screen.getByText(/Could not verify this location automatically/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Confirm location"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ address: typed, providerAddress: null }));
  });

  it("shows both the typed address and the map pin together once confirmed", async () => {
    const value: ConfirmedLocation = {
      address: "15-17 Half Way Tree Road, Kingston, Jamaica",
      providerAddress: "Half Way Tree Rd, Kingston 10",
      point: { lat: 18.0, lng: -76.8 },
    };
    render(<AddressPicker title="Pickup" value={value} onChange={vi.fn()} />);
    expect(screen.getByText(value.address)).toBeInTheDocument();
    expect(screen.getByText(/Provider match:/)).toHaveTextContent(value.providerAddress!);
    expect(screen.getByText(/18.00000, -76.80000/)).toBeInTheDocument();
  });
});
