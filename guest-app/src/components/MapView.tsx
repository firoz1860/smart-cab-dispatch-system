import { MapContainer, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import { bearingDegrees } from "../lib/geo";

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const placeIcon = new L.Icon.Default();

/** A small directional arrow (like Google Maps/Uber's live-location cone)
 * that rotates to face the vehicle's direction of travel - no external
 * image assets needed, just CSS. */
function vehicleIcon(bearingDeg: number): L.DivIcon {
  return L.divIcon({
    className: "vehicle-marker",
    html: `<div class="vehicle-marker-arrow" style="transform: rotate(${bearingDeg}deg)"></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  variant?: "driver" | "place";
}

interface TrackedMarkerState {
  lat: number;
  lng: number;
  bearing: number;
}

const MOVE_ANIMATION_MS = 1200;

/** Imperative marker layer (bypassing react-leaflet's declarative <Marker>)
 * so position changes animate smoothly between GPS updates instead of
 * teleporting, and the driver marker rotates to face its bearing of travel. */
function AnimatedMarkers({ markers }: { markers: MapMarker[] }) {
  const map = useMap();
  const markersRef = useRef(new Map<string, L.Marker>());
  const stateRef = useRef(new Map<string, TrackedMarkerState>());
  const rafRef = useRef(new Map<string, number>());

  useEffect(() => {
    const liveIds = new Set(markers.map((m) => m.id));

    for (const [id, marker] of markersRef.current) {
      if (!liveIds.has(id)) {
        map.removeLayer(marker);
        markersRef.current.delete(id);
        stateRef.current.delete(id);
        const raf = rafRef.current.get(id);
        if (raf) cancelAnimationFrame(raf);
        rafRef.current.delete(id);
      }
    }

    for (const m of markers) {
      const prev = stateRef.current.get(m.id);
      const existing = markersRef.current.get(m.id);

      if (!existing || !prev) {
        const icon = m.variant === "driver" ? vehicleIcon(0) : placeIcon;
        const marker = L.marker([m.lat, m.lng], { icon }).bindPopup(m.label);
        marker.addTo(map);
        markersRef.current.set(m.id, marker);
        stateRef.current.set(m.id, { lat: m.lat, lng: m.lng, bearing: 0 });
        continue;
      }

      existing.setPopupContent(m.label);
      if (prev.lat === m.lat && prev.lng === m.lng) continue;

      const from = { lat: prev.lat, lng: prev.lng };
      const to = { lat: m.lat, lng: m.lng };
      const bearing = m.variant === "driver" ? bearingDegrees(from, to) : prev.bearing;

      const existingRaf = rafRef.current.get(m.id);
      if (existingRaf) cancelAnimationFrame(existingRaf);

      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / MOVE_ANIMATION_MS);
        const eased = 1 - (1 - t) * (1 - t);
        const lat = from.lat + (to.lat - from.lat) * eased;
        const lng = from.lng + (to.lng - from.lng) * eased;
        existing.setLatLng([lat, lng]);
        if (m.variant === "driver") existing.setIcon(vehicleIcon(bearing));
        if (t < 1) {
          rafRef.current.set(m.id, requestAnimationFrame(tick));
        } else {
          stateRef.current.set(m.id, { lat: to.lat, lng: to.lng, bearing });
          rafRef.current.delete(m.id);
        }
      };
      rafRef.current.set(m.id, requestAnimationFrame(tick));
    }
  }, [markers, map]);

  useEffect(() => {
    const markersMap = markersRef.current;
    const rafMap = rafRef.current;
    return () => {
      for (const marker of markersMap.values()) map.removeLayer(marker);
      for (const raf of rafMap.values()) cancelAnimationFrame(raf);
    };
  }, [map]);

  return null;
}

export function MapView({
  markers,
  center,
  height = 320,
}: {
  markers: MapMarker[];
  center: [number, number];
  height?: number;
}) {
  return (
    <div style={{ height, width: "100%", borderRadius: 8, overflow: "hidden" }}>
      <MapContainer center={center} zoom={12} style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <AnimatedMarkers markers={markers} />
      </MapContainer>
    </div>
  );
}
