import type { Trip, TripGuest } from "@prisma/client";

export interface Stop {
  phase: "pickup" | "drop";
  label: string;
  lat: number;
  lng: number;
  stopOrder: number;
  tripGuestIds: string[];
}

export function guestPickup(trip: Trip, g: TripGuest) {
  return {
    label: g.stopPickupLabel ?? trip.pickupLabel,
    lat: g.stopPickupLat ?? trip.pickupLat,
    lng: g.stopPickupLng ?? trip.pickupLng,
  };
}

export function guestDrop(trip: Trip, g: TripGuest) {
  return {
    label: g.stopDropLabel ?? trip.dropLabel,
    lat: g.stopDropLat ?? trip.dropLat,
    lng: g.stopDropLng ?? trip.dropLng,
  };
}

/**
 * Determines the next actionable stop for a (possibly multi-stop, merged)
 * trip: all not-yet-boarded guests are visited in stopOrder for pickup, then
 * once everyone is aboard, all not-yet-dropped guests are visited in
 * stopOrder for drop-off. Guests sharing the same stopOrder are grouped into
 * one stop (they were clustered together, e.g. a family or shared pickup).
 *
 * Returns null once every guest has been picked up and dropped (trip done).
 */
export function getNextStop(trip: Trip, guests: TripGuest[]): Stop | null {
  const unboarded = guests.filter((g) => !g.boarded).sort((a, b) => a.stopOrder - b.stopOrder);
  if (unboarded.length > 0) {
    const targetOrder = unboarded[0].stopOrder;
    const group = unboarded.filter((g) => g.stopOrder === targetOrder);
    const p = guestPickup(trip, group[0]);
    return { phase: "pickup", ...p, stopOrder: targetOrder, tripGuestIds: group.map((g) => g.id) };
  }

  const undropped = guests.filter((g) => !g.droppedOff).sort((a, b) => a.stopOrder - b.stopOrder);
  if (undropped.length > 0) {
    const targetOrder = undropped[0].stopOrder;
    const group = undropped.filter((g) => g.stopOrder === targetOrder);
    const d = guestDrop(trip, group[0]);
    return { phase: "drop", ...d, stopOrder: targetOrder, tripGuestIds: group.map((g) => g.id) };
  }

  return null;
}

/** Guests sharing the same stopOrder were clustered/detoured onto the same
 * physical stop (e.g. a family, or a shared pickup point), so they must
 * collapse into a single display row rather than one row per guest. */
export function allStopsForDisplay(trip: Trip, guests: TripGuest[]) {
  function groupByStop(
    phase: "pickup" | "drop",
    getPoint: (g: TripGuest) => { label: string; lat: number; lng: number },
    isDone: (g: TripGuest) => boolean
  ) {
    const byOrder = new Map<number, { guestIds: string[]; done: boolean } & { label: string; lat: number; lng: number }>();
    for (const g of [...guests].sort((a, b) => a.stopOrder - b.stopOrder)) {
      const point = getPoint(g);
      const existing = byOrder.get(g.stopOrder);
      if (existing) {
        existing.guestIds.push(g.guestId);
        existing.done = existing.done && isDone(g);
      } else {
        byOrder.set(g.stopOrder, { ...point, guestIds: [g.guestId], done: isDone(g) });
      }
    }
    return [...byOrder.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, s]) => ({ phase, label: s.label, lat: s.lat, lng: s.lng, guestId: s.guestIds[0], done: s.done }));
  }

  const pickups = groupByStop("pickup", (g) => guestPickup(trip, g), (g) => g.boarded);
  const drops = groupByStop("drop", (g) => guestDrop(trip, g), (g) => g.droppedOff);
  return [...pickups, ...drops];
}
