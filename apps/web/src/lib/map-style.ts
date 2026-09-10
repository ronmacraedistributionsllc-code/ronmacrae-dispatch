import type { StyleSpecification } from "maplibre-gl";

/**
 * Keyless OpenStreetMap raster tiles — same "no API key required" convention the
 * geocoding fallback already uses (packages/geo/src/osm.ts). No billing, no
 * credentials, shared by the dispatcher map and the customer tracking map.
 */
export const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};
