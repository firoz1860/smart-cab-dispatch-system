import { haversineMeters } from "./geo";

// Same road-windiness assumption used by the Haversine distance/ETA fallback
// (backend/src/lib/distanceProvider.ts) - straight-line distance understates
// actual road distance, so scale it up consistently with the rest of the app.
const ROAD_WINDINESS_FACTOR = 1.35;

// Flat INR fare model for a private event shuttle (not a metered commercial
// taxi) - a base fare plus a per-km rate, applied once per guest booking
// (party), not per seat within that party.
const BASE_FARE_CENTS = 5000; // ₹50
const PER_KM_CENTS = 1500; // ₹15/km

/** Computes the fare, in cents (paise), for a single guest booking's
 * pickup->drop distance. Deterministic and independent of live traffic -
 * fares shouldn't fluctuate with the same jitter/traffic model used for ETAs. */
export function computeFareCents(
  pickup: { lat: number; lng: number },
  drop: { lat: number; lng: number }
): number {
  const straightLineMeters = haversineMeters(pickup, drop);
  const roadKm = (straightLineMeters * ROAD_WINDINESS_FACTOR) / 1000;
  return Math.round(BASE_FARE_CENTS + roadKm * PER_KM_CENTS);
}

export function formatCents(cents: number, currency = "₹"): string {
  return `${currency}${(cents / 100).toFixed(2)}`;
}
