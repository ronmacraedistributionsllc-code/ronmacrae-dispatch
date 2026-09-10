import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  // Real timers throughout: the component's 400ms search debounce is short enough
  // to just wait out for real, and testing-library's async helpers (findBy/waitFor)
  // rely on real timers internally too.
  async function typeAddress(text: string) {
    const input = screen.getByPlaceholderText("Type the exact delivery address…");
    fireEvent.change(input, { target: { value: text } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    return input as HTMLInputElement;
  }

  it("keeps an exact typed address ('15-17 ...') unchanged when a suggestion is picked", async () => {
    const typed = "15-17 Half Way Tree Road, Kingston, Jamaica";
    apiFetchMock.mockResolvedValueOnce(geocodeOk("15-17 Half Way Tree Rd, Kingston 10, Jamaica"));
    const onChange = vi.fn();
    render(<AddressPicker title="Destination" value={null} onChange={onChange} />);

    const input = await typeAddress(typed);
    const suggestionBtn = await screen.findByText("15-17 Half Way Tree Rd, Kingston 10, Jamaica");
    fireEvent.click(suggestionBtn);

    // typed text must be untouched by the pick
    expect(input.value).toBe(typed);
    // the provider match is shown only as secondary info, not substituted in
    expect(screen.getByText(/Provider match:/)).toHaveTextContent("15-17 Half Way Tree Rd, Kingston 10, Jamaica");

    fireEvent.click(screen.getByText("Confirm location"));
    expect(onChange).toHaveBeenCalledWith({
      address: typed,
      providerAddress: "15-17 Half Way Tree Rd, Kingston 10, Jamaica",
      point: { lat: 18.0, lng: -76.8 },
    } satisfies ConfirmedLocation);
  });

  it("keeps the typed address unchanged after dragging the pin (reverse geocode never overwrites it)", async () => {
    const typed = "Apt 4B, 22 Molynes Road, near the blue gate";
    apiFetchMock.mockResolvedValueOnce(geocodeOk("22 Molynes Rd, Kingston, Jamaica"));
    const onChange = vi.fn();
    render(<AddressPicker title="Destination" value={null} onChange={onChange} />);

    const input = await typeAddress(typed);
    fireEvent.click(await screen.findByText("22 Molynes Rd, Kingston, Jamaica"));

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

  it("lets 'Use this address' confirm exact typed text even when the provider finds no match", async () => {
    const typed = "Behind the yellow shop, off Windward Road, no fixed number";
    apiFetchMock.mockResolvedValueOnce(geocodeEmpty()); // live suggestion search: nothing
    const onChange = vi.fn();
    render(<AddressPicker title="Destination" value={null} onChange={onChange} />);

    const input = await typeAddress(typed);
    expect(screen.getByText(/No suggestions matched/)).toBeInTheDocument();

    apiFetchMock.mockResolvedValueOnce(geocodeEmpty()); // "Use this address" geocode attempt: still nothing
    fireEvent.click(screen.getByText("Use this address"));
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

  it("does not overwrite already-typed text with a suggestion label when the field wasn't empty", async () => {
    const onChange = vi.fn();
    render(<AddressPicker title="Destination" value={null} onChange={onChange} />);
    apiFetchMock.mockResolvedValueOnce(geocodeOk("Half Way Tree Rd"));
    const input = await typeAddress("17 Grants Pen Road");
    fireEvent.click(await screen.findByText("Half Way Tree Rd"));
    expect(input.value).toBe("17 Grants Pen Road");
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
