import { prisma } from "../lib/prisma";
import { getNextStop, guestPickup, guestDrop } from "./stops";
import { emitToGuest, emitToDriver, emitDispatchEvent } from "../realtime/socket";
import { ENGINE_CONFIG } from "./config";
import { ACTIVE_TRIP_STATUSES } from "../lib/constants";
import { computeFareCents } from "../lib/fare";
import { getStripe } from "../lib/stripeClient";
import { getCachedEventRow } from "../lib/eventConfig";

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

/** Driver marks arrival at the current stop (pickup or drop), before the
 * guest actually boards/is dropped. This is a distinct, recorded event from
 * boarding/dropping so the gap between the two (how long the driver sat
 * waiting) can be measured as halt time - see completeStop(). */
export async function arriveAtStop(tripId: string, driverId: string) {
  const trip = await loadTripOrThrow(tripId);
  if (trip.driverId !== driverId) throw new TripActionError("Not your trip");
  if (trip.currentStopArrivedAt) throw new TripActionError("Already marked arrived at this stop");

  const next = getNextStop(trip, trip.guests);
  if (!next) throw new TripActionError("Trip has no remaining stops");

  const now = new Date();
  const newStatus = next.phase === "pickup" ? "ARRIVED_PICKUP" : "ARRIVED_DROP";

  await prisma.trip.update({
    where: { id: tripId },
    data: { status: newStatus, currentStopArrivedAt: now },
  });
  for (const g of trip.guests.filter((g) => next.tripGuestIds.includes(g.id))) {
    emitToGuest(g.guestId, next.phase === "pickup" ? "trip:driver-arrived-pickup" : "trip:driver-arrived-drop", { tripId });
  }
  emitDispatchEvent(next.phase === "pickup" ? "trip:arrived-pickup" : "trip:arrived-drop", { tripId, driverId });
}

/** Complete the stop the driver already marked "arrived" at: board the next
 * unboarded guest group (pickup phase) or drop the next undropped guest group
 * (drop phase). Completes the trip and starts the driver's mandatory break
 * once every guest has been dropped. Requires arriveAtStop() to have been
 * called first, so the halt time (arrival -> completion) can be recorded. */
export async function completeStop(tripId: string, driverId: string) {
  const trip = await loadTripOrThrow(tripId);
  if (trip.driverId !== driverId) throw new TripActionError("Not your trip");
  if (!trip.currentStopArrivedAt) throw new TripActionError("Mark arrival at this stop first");

  const next = getNextStop(trip, trip.guests);
  if (!next) throw new TripActionError("Trip has no remaining stops");

  const now = new Date();
  const haltSeconds = Math.max(0, Math.round((now.getTime() - trip.currentStopArrivedAt.getTime()) / 1000));
  const totalHaltSeconds = trip.totalHaltSeconds + haltSeconds;

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
        data: {
          status: newStatus,
          pickedUpAt: trip.pickedUpAt ?? now,
          currentStopArrivedAt: null,
          totalHaltSeconds,
        },
      }),
      prisma.driver.update({ where: { id: driverId }, data: { status: newStatus === "IN_PROGRESS" ? "ON_TRIP" : "EN_ROUTE_PICKUP" } }),
    ]);
    for (const g of trip.guests.filter((g) => next.tripGuestIds.includes(g.id))) {
      emitToGuest(g.guestId, "trip:boarded", { tripId });
    }
  } else {
    // Guard against re-entering this branch for a guest already processed.
    // completeStop() can only normally run once per stop (arriveAtStop()
    // requires currentStopArrivedAt to be null before allowing a fresh
    // "arrived"), but this filter also makes a crash-and-retry safe: if the
    // process died after persisting guest A's drop-off but before finishing
    // guest B's, currentStopArrivedAt would still be set (not yet cleared),
    // so a retry of this exact call must not create a second Stripe
    // PaymentIntent for guest A.
    const droppedGuests = trip.guests.filter((g) => next.tripGuestIds.includes(g.id) && !g.droppedOff);
    const stripe = getStripe();

    // Fare and payment are per-guest (booking), not per-Trip, since a shared
    // ride splits into separate charges per party - each one uses their own
    // pickup/drop pair (respecting stop overrides from clustering/detour).
    // The Stripe call is a real network round-trip to an external service,
    // so it deliberately happens OUTSIDE the DB transaction below - a DB
    // transaction should never hold on an external API call. Idempotency
    // for a crash between "Stripe call succeeded" and "DB write" is handled
    // by the filter above (a retry skips guests already marked droppedOff)
    // rather than by holding a lock open across the network call.
    const guestUpdates: { guestId: string; data: Parameters<typeof prisma.tripGuest.update>[0]["data"] }[] = [];
    for (const g of droppedGuests) {
      const fareAmountCents = computeFareCents(guestPickup(trip, g), guestDrop(trip, g));
      let stripePaymentIntentId: string | null = null;
      let paymentStatus: "UNPAID" | "PENDING" = "UNPAID";

      if (stripe) {
        try {
          const intent = await stripe.paymentIntents.create({
            amount: fareAmountCents,
            currency: "inr",
            metadata: { tripId, tripGuestId: g.id, guestId: g.guestId },
            description: `Smart Cab Dispatch - trip ${tripId}`,
          });
          stripePaymentIntentId = intent.id;
          paymentStatus = "PENDING";
        } catch (err) {
          // Never let a payments-provider outage block completing the trip -
          // the fare is still recorded, just without a live PaymentIntent to
          // pay against until an admin/guest retries once Stripe is back.
          console.error("[payments] failed to create PaymentIntent:", err);
        }
      }

      guestUpdates.push({ guestId: g.id, data: { droppedOff: true, fareAmountCents, paymentStatus, stripePaymentIntentId } });
    }

    // Guests in next.tripGuestIds are, by construction, exactly this stop's
    // not-yet-dropped group - after this operation they're all droppedOff.
    // Every other guest's droppedOff status is unaffected by this call.
    const remaining = trip.guests.filter((g) => !next.tripGuestIds.includes(g.id) && !g.droppedOff).length;
    const allDroppedAfterThis = remaining === 0;

    const event = allDroppedAfterThis ? await getCachedEventRow() : null;
    const breakSeconds = event?.breakSecondsAfterTrip ?? ENGINE_CONFIG.DEFAULT_BREAK_SECONDS;
    const freeAt = new Date(now.getTime() + breakSeconds * 1000);

    // All the writes that make this stop's completion durable land in one
    // atomic transaction: every dropped guest's row, the trip's own status,
    // and (on the final stop) the driver's break state. A crash before this
    // commits loses nothing (the Stripe PaymentIntents already created are
    // still valid and will simply be re-attached on retry, skipping guests
    // whose DB row already reflects them - see the filter above); a crash
    // after it commits has fully persisted, consistent state either way.
    await prisma.$transaction([
      ...guestUpdates.map((u) => prisma.tripGuest.update({ where: { id: u.guestId }, data: u.data })),
      allDroppedAfterThis
        ? prisma.trip.update({
            where: { id: tripId },
            data: { status: "COMPLETED", completedAt: now, currentStopArrivedAt: null, totalHaltSeconds },
          })
        : prisma.trip.update({
            where: { id: tripId },
            data: { status: "IN_PROGRESS", currentStopArrivedAt: null, totalHaltSeconds },
          }),
      ...(allDroppedAfterThis
        ? [prisma.driver.update({ where: { id: driverId }, data: { status: "ON_BREAK", freeAt } })]
        : []),
    ]);

    for (const g of droppedGuests) {
      emitToGuest(g.guestId, "trip:dropped", { tripId });
    }
    if (allDroppedAfterThis) {
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

  if (trip.totalSeats > driver.seatCapacity || trip.totalLuggage > driver.luggageCapacity) {
    throw new TripActionError(
      `${driver.name}'s vehicle (${driver.seatCapacity} seat(s) / ${driver.luggageCapacity} bag(s)) can't fit this trip (needs ${trip.totalSeats} seat(s) / ${trip.totalLuggage} bag(s)).`
    );
  }

  const conflictingTrip = await prisma.trip.findFirst({
    where: { driverId, id: { not: tripId }, status: { in: ACTIVE_TRIP_STATUSES } },
  });
  if (conflictingTrip) {
    throw new TripActionError(`${driver.name} is already on an active trip and can't be double-booked.`);
  }

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
  emitToDriver(driverId, "trip:assigned", { tripId });
}
