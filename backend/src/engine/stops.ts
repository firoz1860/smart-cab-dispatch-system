import type { Trip, TripGuest } from "@prisma/client";

export interface Stop {
  phase: "pickup" | "drop";
  label: string;
  lat: number;
  lng: number;
  stopOrder: number;
  tripGuestIds: string[];
}

function guestPickup(trip: Trip, g: TripGuest) {
  return {
    label: g.stopPickupLabel ?? trip.pickupLabel,
    lat: g.stopPickupLat ?? trip.pickupLat,
    lng: g.stopPickupLng ?? trip.pickupLng,
  };
}

function guestDrop(trip: Trip, g: TripGuest) {
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

export function allStopsForDisplay(trip: Trip, guests: TripGuest[]) {
  const pickups = [...guests]
    .sort((a, b) => a.stopOrder - b.stopOrder)
    .map((g) => ({ phase: "pickup" as const, ...guestPickup(trip, g), guestId: g.guestId, done: g.boarded }));
  const drops = [...guests]
    .sort((a, b) => a.stopOrder - b.stopOrder)
    .map((g) => ({ phase: "drop" as const, ...guestDrop(trip, g), guestId: g.guestId, done: g.droppedOff }));
  return [...pickups, ...drops];
}
