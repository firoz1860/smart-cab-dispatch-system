import { prisma } from "../lib/prisma";
import { getDistanceProvider } from "../lib/distanceProvider";
import { clusterQueuedTrips } from "./clustering";
import { splitOversizedTrips } from "./splitting";
import { computePriorityScore } from "./priority";
import { getNextStop } from "./stops";
import { ENGINE_CONFIG } from "./config";
import { DRIVER_ACTIVE_TRIP_STATUSES } from "../lib/constants";
import type { Driver, Trip, TripGuest } from "@prisma/client";
import { emitDispatchEvent, emitToDriver } from "../realtime/socket";

async function getEventConfig() {
  const event = await prisma.event.findFirst();
  return {
    maxDetourSeconds: event?.maxDetourSeconds ?? ENGINE_CONFIG.DEFAULT_MAX_DETOUR_SECONDS,
    breakSeconds: event?.breakSecondsAfterTrip ?? ENGINE_CONFIG.DEFAULT_BREAK_SECONDS,
  };
}

/** Promote drivers whose mandatory rest period has elapsed back to AVAILABLE. */
export async function refreshDriverAvailability(now: Date = new Date()): Promise<void> {
  await prisma.driver.updateMany({
    where: { status: "ON_BREAK", freeAt: { lte: now } },
    data: { status: "AVAILABLE", freeAt: null },
  });
}

/** Recompute live ETAs for every trip currently in flight, reflecting the
 * driver's current position and simulated live traffic. Also refreshes each
 * busy driver's predicted freeAt, which feeds both the cost function (so we
 * don't assign a "free" driver who is actually about to finish a longer job
 * elsewhere) and the Admin dashboard. */
export async function recomputeLiveEtas(now: Date = new Date()): Promise<void> {
  const provider = getDistanceProvider();
  const { breakSeconds } = await getEventConfig();

  const activeTrips = await prisma.trip.findMany({
    where: { status: { in: DRIVER_ACTIVE_TRIP_STATUSES } },
    include: { guests: true, driver: true },
  });

  for (const trip of activeTrips) {
    if (!trip.driver) continue;
    const next = getNextStop(trip, trip.guests);
    if (!next) continue;
    const eta = await provider.getEta(
      { lat: trip.driver.currentLat, lng: trip.driver.currentLng },
      { lat: next.lat, lng: next.lng },
      now
    );
    await prisma.trip.update({ where: { id: trip.id }, data: { etaSeconds: eta.durationSeconds } });

    // Rough predicted free time: time to finish this stop + any remaining
    // stops after it (approximated via total remaining seconds) + break.
    const remainingStops = trip.guests.length; // upper bound approximation
    const predictedFreeAt = new Date(
      now.getTime() + eta.durationSeconds * 1000 * Math.max(1, remainingStops / 2) + breakSeconds * 1000
    );
    await prisma.driver.update({ where: { id: trip.driver.id }, data: { freeAt: predictedFreeAt } });
  }
}

function priorityFor(t: Pick<Trip, "requestedAt" | "scheduledTime" | "deadline">, now: Date) {
  return computePriorityScore({
    requestedAt: t.requestedAt,
    scheduledTime: t.scheduledTime,
    deadline: t.deadline,
    now,
  });
}

async function assignDriverToTrip(trip: Trip, driver: Driver, now: Date) {
  await prisma.$transaction([
    prisma.trip.update({
      where: { id: trip.id },
      data: { driverId: driver.id, status: "ASSIGNED", assignedAt: now },
    }),
    prisma.driver.update({ where: { id: driver.id }, data: { status: "ASSIGNED" } }),
  ]);
  emitDispatchEvent("trip:assigned", { tripId: trip.id, driverId: driver.id });
  emitToDriver(driver.id, "trip:assigned", { tripId: trip.id });
}

/**
 * Nearest-driver batch assignment over every currently QUEUED trip (post
 * clustering/splitting) and every currently AVAILABLE driver: each trip is
 * assigned to a feasible (capacity-permitting) nearby driver, using the
 * distance provider's road-aware ETA (Google Distance Matrix, or the
 * Haversine + traffic-simulation fallback) as the "shortest path" cost.
 *
 * Trips are processed most-urgent-first (by wait time / deadline) so a
 * driver isn't claimed by a nearer-but-lower-priority trip before a
 * longer-waiting guest gets a turn.
 *
 * Driver choice within a trip is nearest-first, but not *purely* nearest:
 * among feasible drivers within CAPACITY_FIT_ETA_CEILING_SECONDS (or the
 * single nearest driver's ETA, whichever is greater), the best-fitting
 * (smallest sufficient) vehicle wins, tie-broken by ETA. Without this, a
 * nearby 10-seat van can get wastefully assigned to a 1-seat trip while a
 * comparably-close 4-seat sedan sits idle, leaving a later 6-seat group with
 * no capable vehicle left even though the van was free moments earlier. The
 * ceiling ensures this preference never forces a guest to wait past a
 * reasonable ETA just for a "perfect" vehicle size - past that ceiling, the
 * nearest feasible driver wins outright regardless of fit.
 */
export async function runBatchAssignment(now: Date = new Date()): Promise<{
  assigned: number;
  stillQueued: number;
}> {
  const provider = getDistanceProvider();

  const [drivers, trips] = await Promise.all([
    prisma.driver.findMany({ where: { status: "AVAILABLE" } }),
    prisma.trip.findMany({ where: { status: "QUEUED" }, include: { guests: true } }),
  ]);

  if (drivers.length === 0 || trips.length === 0) {
    return { assigned: 0, stillQueued: trips.length };
  }

  const orderedTrips = [...trips].sort((a, b) => priorityFor(b, now) - priorityFor(a, now));

  const etaMatrix = await provider.getEtaMatrix(
    drivers.map((d) => ({ lat: d.currentLat, lng: d.currentLng })),
    orderedTrips.map((t) => ({ lat: t.pickupLat, lng: t.pickupLng })),
    now
  );

  const availableDriverIdx = new Set(drivers.map((_, i) => i));
  let assigned = 0;

  for (let tripIdx = 0; tripIdx < orderedTrips.length; tripIdx++) {
    const trip = orderedTrips[tripIdx];

    const feasible: { driverIdx: number; etaSeconds: number }[] = [];
    for (const driverIdx of availableDriverIdx) {
      const driver = drivers[driverIdx];
      const capacityOk = trip.totalSeats <= driver.seatCapacity && trip.totalLuggage <= driver.luggageCapacity;
      if (!capacityOk) continue;
      feasible.push({ driverIdx, etaSeconds: etaMatrix[driverIdx][tripIdx].durationSeconds });
    }
    if (feasible.length === 0) continue;

    const nearestEtaSeconds = Math.min(...feasible.map((f) => f.etaSeconds));
    const ceiling = Math.max(nearestEtaSeconds, ENGINE_CONFIG.CAPACITY_FIT_ETA_CEILING_SECONDS);

    let bestDriverIdx = -1;
    let bestCapacity = Infinity;
    let bestEtaSeconds = Infinity;
    for (const { driverIdx, etaSeconds } of feasible) {
      if (etaSeconds > ceiling) continue; // too far to justify waiting for, regardless of fit
      const capacity = drivers[driverIdx].seatCapacity;
      if (capacity < bestCapacity || (capacity === bestCapacity && etaSeconds < bestEtaSeconds)) {
        bestCapacity = capacity;
        bestEtaSeconds = etaSeconds;
        bestDriverIdx = driverIdx;
      }
    }

    if (bestDriverIdx === -1) continue;

    await assignDriverToTrip(trip, drivers[bestDriverIdx], now);
    availableDriverIdx.delete(bestDriverIdx);
    assigned += 1;
  }

  return { assigned, stillQueued: orderedTrips.length - assigned };
}

/**
 * Opportunistic detour insertion: for a single QUEUED trip, look for a driver
 * already EN_ROUTE_PICKUP or ON_TRIP (using their *live* current position,
 * not their original route) with enough spare seat/luggage capacity, and
 * check whether adding this pickup+drop before their next stop fits within
 * the configured max-detour budget without pushing their existing guests
 * past any deadline. Returns true if inserted.
 */
export async function tryDetourInsertion(tripId: string, now: Date = new Date()): Promise<boolean> {
  const { maxDetourSeconds } = await getEventConfig();
  const provider = getDistanceProvider();

  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: { guests: true } });
  if (!trip || trip.status !== "QUEUED") return false;

  const candidates = await prisma.driver.findMany({
    where: { status: { in: ["EN_ROUTE_PICKUP", "ON_TRIP"] } },
    include: { trips: { where: { status: { in: DRIVER_ACTIVE_TRIP_STATUSES } }, include: { guests: true } } },
  });

  let best: { driver: Driver; activeTrip: Trip & { guests: TripGuest[] }; addedSeconds: number } | null = null;

  for (const driver of candidates) {
    const activeTrip = driver.trips[0];
    if (!activeTrip) continue;

    const spareSeats = driver.seatCapacity - activeTrip.totalSeats;
    const spareLuggage = driver.luggageCapacity - activeTrip.totalLuggage;
    if (trip.totalSeats > spareSeats || trip.totalLuggage > spareLuggage) continue;

    const nextStop = getNextStop(activeTrip, activeTrip.guests);
    if (!nextStop) continue;

    const driverPos = { lat: driver.currentLat, lng: driver.currentLng };
    const [baseline, toNewPickup, newPickupToNext] = await Promise.all([
      provider.getEta(driverPos, { lat: nextStop.lat, lng: nextStop.lng }, now),
      provider.getEta(driverPos, { lat: trip.pickupLat, lng: trip.pickupLng }, now),
      provider.getEta({ lat: trip.pickupLat, lng: trip.pickupLng }, { lat: nextStop.lat, lng: nextStop.lng }, now),
    ]);

    const addedSeconds =
      toNewPickup.durationSeconds + newPickupToNext.durationSeconds - baseline.durationSeconds;
    if (addedSeconds > maxDetourSeconds) continue;

    // Don't break an existing deadline: if the trip has one, check the extra
    // time doesn't push arrival past it.
    if (activeTrip.deadline) {
      const projectedArrival = now.getTime() + (baseline.durationSeconds + addedSeconds) * 1000;
      if (projectedArrival > activeTrip.deadline.getTime()) continue;
    }

    if (!best || addedSeconds < best.addedSeconds) {
      best = { driver, activeTrip, addedSeconds };
    }
  }

  if (!best) return false;

  const maxStopOrder = best.activeTrip.guests.reduce((m, g) => Math.max(m, g.stopOrder), 0);

  await prisma.$transaction(async (tx) => {
    for (const g of trip.guests) {
      await tx.tripGuest.update({
        where: { id: g.id },
        data: {
          tripId: best!.activeTrip.id,
          stopPickupLabel: trip.pickupLabel,
          stopPickupLat: trip.pickupLat,
          stopPickupLng: trip.pickupLng,
          stopDropLabel: trip.dropLabel,
          stopDropLat: trip.dropLat,
          stopDropLng: trip.dropLng,
          stopOrder: maxStopOrder + 1,
        },
      });
    }
    await tx.trip.update({
      where: { id: best!.activeTrip.id },
      data: {
        totalSeats: best!.activeTrip.totalSeats + trip.totalSeats,
        totalLuggage: best!.activeTrip.totalLuggage + trip.totalLuggage,
      },
    });
    await tx.trip.update({
      where: { id: trip.id },
      data: { status: "CANCELLED", mergedIntoTripId: best!.activeTrip.id, driverId: best!.driver.id },
    });
  });

  emitDispatchEvent("trip:detour-merged", {
    tripId: trip.id,
    intoTripId: best.activeTrip.id,
    driverId: best.driver.id,
  });
  return true;
}

/**
 * Priority-ordered pass over anything still QUEUED after batch assignment:
 * tries a detour insertion into an already-busy driver first (keeps drivers
 * from sitting idle-adjacent while making use of spare capacity), then falls
 * back to the Hungarian batch pass. Flags long-waiting trips as UNASSIGNABLE
 * for Admin/Operations visibility (still retried automatically every tick).
 */
export async function processRealtimeQueue(now: Date = new Date()): Promise<void> {
  const queued = await prisma.trip.findMany({ where: { status: "QUEUED" } });
  const ordered = [...queued].sort((a, b) => priorityFor(b, now) - priorityFor(a, now));

  for (const trip of ordered) {
    const inserted = await tryDetourInsertion(trip.id, now);
    if (inserted) continue;

    const waitedMin = (now.getTime() - trip.requestedAt.getTime()) / 60000;
    if (waitedMin >= ENGINE_CONFIG.UNASSIGNABLE_WAIT_THRESHOLD_MIN) {
      await prisma.trip.update({
        where: { id: trip.id },
        data: { status: "UNASSIGNABLE" },
      });
      emitDispatchEvent("trip:unassignable", { tripId: trip.id });
    }
  }

  // Give Hungarian a chance to place anything a detour couldn't absorb,
  // including trips just flagged UNASSIGNABLE (they're retried below and
  // flip back to ASSIGNED automatically the moment a driver frees up).
  await prisma.trip.updateMany({
    where: { status: "UNASSIGNABLE" },
    data: { status: "QUEUED" },
  });
  await runBatchAssignment(now);
}

let tickRunning = false;

/** Full re-optimization pass: split -> cluster -> detour/priority queue ->
 * batch assignment -> live ETA refresh. Safe to call concurrently (re-entrant
 * calls are skipped) - triggered both by the periodic interval and by
 * mutating API routes for immediate responsiveness. */
export async function runDispatchTick(): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const now = new Date();
    await refreshDriverAvailability(now);
    await splitOversizedTrips();
    await clusterQueuedTrips();
    await processRealtimeQueue(now);
    await recomputeLiveEtas(now);
  } catch (err) {
    console.error("[matchingEngine] dispatch tick failed:", err);
  } finally {
    tickRunning = false;
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startDispatchLoop(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void runDispatchTick();
  }, ENGINE_CONFIG.REOPTIMIZE_INTERVAL_MS);
}

export function stopDispatchLoop(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
