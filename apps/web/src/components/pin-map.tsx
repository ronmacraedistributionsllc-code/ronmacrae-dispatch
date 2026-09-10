import React, { useEffect, useRef } from "react";
import { Map as MapLibreMap, Marker, NavigationControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { OSM_STYLE } from "../lib/map-style.js";

/**
 * A single draggable marker on a map — the "confirm location" step of the
 * address-first order-creation flow. Reports the marker's new point on drag end;
 * the caller (address-picker.tsx) is responsible for reverse-geocoding it back to
 * a label and for the "confirm" affordance — this component only draws the pin.
 */
export function PinMap({ lat, lng, onMove }: { lat: number; lng: number; onMove: (point: { lat: number; lng: number }) => void }): React.JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  useEffect(() => {
    if (!container.current) return;
    const map = new MapLibreMap({ container: container.current, style: OSM_STYLE, center: [lng, lat], zoom: 15 });
    map.addControl(new NavigationControl(), "top-right");
    const marker = new Marker({ draggable: true, color: "#e11d48" }).setLngLat([lng, lat]).addTo(map);
    marker.on("dragend", () => {
      const pos = marker.getLngLat();
      onMoveRef.current({ lat: pos.lat, lng: pos.lng });
    });
    map.on("click", (e) => {
      marker.setLngLat(e.lngLat);
      onMoveRef.current({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    mapRef.current = map;
    markerRef.current = marker;
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Intentionally init-once — the effect below re-syncs position when the parent's
    // confirmed point changes for a reason other than dragging this same pin (e.g.
    // picking a new search suggestion).
  }, []);

  useEffect(() => {
    const marker = markerRef.current;
    const map = mapRef.current;
    if (!marker || !map) return;
    const current = marker.getLngLat();
    if (Math.abs(current.lat - lat) > 1e-9 || Math.abs(current.lng - lng) > 1e-9) {
      marker.setLngLat([lng, lat]);
      map.setCenter([lng, lat]);
    }
  }, [lat, lng]);

  return <div ref={container} className="h-64 w-full overflow-hidden rounded-lg" />;
}
