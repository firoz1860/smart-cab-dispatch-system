import { prisma } from "../lib/prisma";
import { getNextStop } from "./stops";
import { emitToGuest, emitDispatchEvent } from "../realtime/socket";
import { ENGINE_CONFIG } from "./config";

export class TripActionError extends Error {}

async function loadTripOrThrow(tripId: string) {
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: { guests: true, driver: true } });
  if (!trip) throw new TripActionError("Trip not found");
  return trip;
}

/** Driver accepts their assigned trip: begins heading to the first pickup stop. */
export async function acceptTrip(tripId: string, driverId: string) {
  const trip = await loadTripOrThrow(tripId);
  if (trip.driverId !== driverId) throw new TripActionError("Not your trip");
  if (trip.status !== "ASSIGNED") throw new TripActionError(`Cannot accept a trip in status ${trip.status}`);

  await prisma.$transaction([
    prisma.trip.update({ where: { id: tripId }, data: { status: "EN_ROUTE_PICKUP" } }),
    prisma.driver.update({ where: { id: driverId }, data: { status: "EN_ROUTE_PICKUP" } }),
  ]);
  for (const g of trip.guests) {
    emitToGuest(g.guestId, "trip:matched", { tripId, driverId });
  }
  emitDispatchEvent("trip:accepted", { tripId, driverId });
}

/** Driver rejects their assigned trip: it's re-queued for reassignment, and
 * this driver is recorded so the engine avoids immediately re-offering it to
 * them again. */
export async function rejectTrip(tripId: string, driverId: string) {
  const trip = await loadTripOrThrow(tripId);
  if (trip.driverId !== driverId) throw new TripActionError("Not your trip");
  if (trip.status !== "ASSIGNED") throw new TripActionError(`Cannot reject a trip in status ${trip.status}`);

  const rejectedIds = trip.rejectedDriverIds ? trip.rejectedDriverIds.split(",") : [];
  rejectedIds.push(driverId);

  await prisma.$transaction([
    prisma.trip.update({
      where: { id: tripId },
      data: { status: "QUEUED", driverId: null, assignedAt: null, rejectedDriverIds: rejectedIds.join(",") },
    }),
    prisma.driver.update({ where: { id: driverId }, data: { status: "AVAILABLE" } }),
  ]);
  emitDispatchEvent("trip:rejected", { tripId, driverId });
}

/** Advance the driver's current trip by one stop: either boarding the next
 * unboarded guest group (pickup phase) or dropping the next undropped guest
 * group (drop phase). Completes the trip and starts the driver's mandatory
 * break once every guest has been dropped. */
export async function advanceTripStop(tripId: string, driverId: string) {
  const trip = await loadTripOrThrow(tripId);
  if (trip.driverId !== driverId) throw new TripActionError("Not your trip");

  const next = getNextStop(trip, trip.guests);
  if (!next) throw new TripActionError("Trip has no remaining stops");

  const now = new Date();

  if (next.phase === "pickup") {
    await prisma.tripGuest.updateMany({
      where: { id: { in: next.tripGuestIds } },
      data: { boarded: true },
    });
    const remaining = await prisma.tripGuest.count({ where: { tripId, boarded: false } });
    const newStatus = remaining === 0 ? "IN_PROGRESS" : "EN_ROUTE_PICKUP";
    await prisma.$transaction([
      prisma.trip.update({
        where: { id: tripId },
        data: { status: newStatus, pickedUpAt: trip.pickedUpAt ?? now },
      }),
      prisma.driver.update({ where: { id: driverId }, data: { status: newStatus === "IN_PROGRESS" ? "ON_TRIP" : "EN_ROUTE_PICKUP" } }),
    ]);
    for (const g of trip.guests.filter((g) => next.tripGuestIds.includes(g.id))) {
      emitToGuest(g.guestId, "trip:boarded", { tripId });
    }
  } else {
    await prisma.tripGuest.updateMany({
      where: { id: { in: next.tripGuestIds } },
      data: { droppedOff: true },
    });
    const remaining = await prisma.tripGuest.count({ where: { tripId, droppedOff: false } });
    for (const g of trip.guests.filter((g) => next.tripGuestIds.includes(g.id))) {
      emitToGuest(g.guestId, "trip:dropped", { tripId });
    }

    if (remaining === 0) {
      const event = await prisma.event.findFirst();
      const breakSeconds = event?.breakSecondsAfterTrip ?? ENGINE_CONFIG.DEFAULT_BREAK_SECONDS;
      const freeAt = new Date(now.getTime() + breakSeconds * 1000);
      await prisma.$transaction([
        prisma.trip.update({ where: { id: tripId }, data: { status: "COMPLETED", completedAt: now } }),
        prisma.driver.update({ where: { id: driverId }, data: { status: "ON_BREAK", freeAt } }),
      ]);
      emitDispatchEvent("trip:completed", { tripId, driverId });
    }
  }
}

/** Admin manual override: force-assign a specific driver to a trip,
 * bypassing the matching engine (e.g. priority guest, vehicle breakdown
 * workaround, or a case the auto-matcher couldn't resolve). */
export async function adminOverrideAssign(tripId: string, driverId: string, note?: string) {
  const trip = await loadTripOrThrow(tripId);
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw new TripActionError("Driver not found");

  await prisma.$transaction([
    prisma.trip.update({
      where: { id: tripId },
      data: {
        driverId,
        status: "ASSIGNED",
        assignedAt: new Date(),
        adminOverride: true,
        adminNote: note ?? trip.adminNote,
      },
    }),
    prisma.driver.update({ where: { id: driverId }, data: { status: "ASSIGNED" } }),
  ]);
  emitDispatchEvent("trip:admin-override", { tripId, driverId });
}
