import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { getNextStop } from "../engine/stops";
import { GUEST_BLOCKING_TRIP_STATUSES, DRIVER_ACTIVE_TRIP_STATUSES, DRIVER_FARE_SHARE } from "../lib/constants";
import { getStripe } from "../lib/stripeClient";
import { emitToGuest, emitDispatchEvent } from "../realtime/socket";

export const guestRouter = Router();
guestRouter.use(requireAuth, requireRole("GUEST"));

function guestId(req: import("express").Request): string {
  return req.auth!.guestId!;
}

guestRouter.get("/me", async (req, res) => {
  const guest = await prisma.guest.findUnique({
    where: { id: guestId(req) },
    include: { accommodation: true },
  });
  res.json(guest);
});

/** All of this guest's trips across the event (scheduled + on-demand),
 * newest first - lets the guest see upcoming pickups and past rides. */
guestRouter.get("/trips", async (req, res) => {
  // Filter out CANCELLED trips and sort newest-first in the database (backed by
  // the TripGuest.guestId index) rather than pulling every row and doing it in
  // JS - smaller result set and no post-processing on the hot, polled path.
  const tripGuests = await prisma.tripGuest.findMany({
    where: { guestId: guestId(req), trip: { status: { not: "CANCELLED" } } },
    include: { trip: { include: { driver: true } } },
    orderBy: { trip: { requestedAt: "desc" } },
  });
  const trips = tripGuests.map((tg) => ({
    ...tg.trip,
    myStopOrder: tg.stopOrder,
    myBoarded: tg.boarded,
    myDroppedOff: tg.droppedOff,
    myFareAmountCents: tg.fareAmountCents,
    myPaymentStatus: tg.paymentStatus,
  }));
  res.json(trips);
});

/** Fetches (or re-fetches) the Stripe PaymentIntent client secret for this
 * guest's fare on a completed trip, so the frontend can collect payment via
 * Stripe Elements. The fare/PaymentIntent itself is created when the guest is
 * dropped off (see backend/src/engine/tripActions.ts completeStop). */
guestRouter.get("/trips/:tripId/payment", async (req, res) => {
  const tripGuest = await prisma.tripGuest.findUnique({
    where: { tripId_guestId: { tripId: req.params.tripId, guestId: guestId(req) } },
  });
  if (!tripGuest) return res.status(404).json({ error: "Trip not found" });
  if (tripGuest.paymentStatus === "PAID") {
    return res.json({ fareAmountCents: tripGuest.fareAmountCents, paymentStatus: tripGuest.paymentStatus, clientSecret: null });
  }
  if (tripGuest.fareAmountCents == null) {
    return res.status(400).json({ error: "No fare has been calculated for this trip yet" });
  }
  const stripe = getStripe();
  if (!stripe || !tripGuest.stripePaymentIntentId) {
    return res.status(503).json({ error: "Payments are not configured for this event yet" });
  }

  const intent = await stripe.paymentIntents.retrieve(tripGuest.stripePaymentIntentId);
  res.json({
    clientSecret: intent.client_secret,
    fareAmountCents: tripGuest.fareAmountCents,
    paymentStatus: tripGuest.paymentStatus,
  });
});

/** Guest confirms an off-Stripe QR/UPI payment for their fare: they scan the
 * QR, pay in their own UPI app, then tap "I've completed payment". This is a
 * manual, trust-based confirmation - there's no automatic bank verification
 * like the Stripe webhook - but it reuses the EXACT same TripGuest payment
 * fields and driver-earnings crediting as the Stripe path, so downstream
 * reporting is identical regardless of how a fare was paid.
 *
 * Idempotent and double-credit-safe: the PAID transition only fires while the
 * row is still UNPAID/PENDING (re-checked inside the transaction), so a double
 * tap, a retry, or a Stripe webhook arriving for the same booking can't credit
 * the driver twice. The Stripe flow is left completely unchanged. */
guestRouter.post("/trips/:tripId/confirm-qr-payment", async (req, res) => {
  const tripGuest = await prisma.tripGuest.findUnique({
    where: { tripId_guestId: { tripId: req.params.tripId, guestId: guestId(req) } },
  });
  if (!tripGuest) return res.status(404).json({ error: "Trip not found" });
  if (tripGuest.fareAmountCents == null) {
    return res.status(400).json({ error: "No fare has been calculated for this trip yet" });
  }
  if (tripGuest.paymentStatus === "PAID") {
    return res.json({ paymentStatus: "PAID" }); // already paid - idempotent no-op
  }

  const applied = await prisma.$transaction(async (tx) => {
    const { count } = await tx.tripGuest.updateMany({
      where: { id: tripGuest.id, paymentStatus: { in: ["UNPAID", "PENDING"] } },
      data: { paymentStatus: "PAID", paidAt: new Date() },
    });
    if (count === 0) return false; // another confirmation won the race - nothing to do

    const trip = await tx.trip.findUnique({ where: { id: tripGuest.tripId } });
    if (trip?.driverId && tripGuest.fareAmountCents) {
      const driverShareCents = Math.round(tripGuest.fareAmountCents * DRIVER_FARE_SHARE);
      await tx.driver.update({
        where: { id: trip.driverId },
        data: { totalEarningsCents: { increment: driverShareCents } },
      });
    }
    return true;
  });

  if (applied) {
    emitToGuest(guestId(req), "payment:updated", { tripId: tripGuest.tripId, status: "PAID" });
    emitDispatchEvent("payment:updated", { tripGuestId: tripGuest.id, status: "PAID" });
  }
  res.json({ paymentStatus: "PAID" });
});

/** The guest's currently active trip (if matched), including driver name,
 * vehicle number, and live ETA - for the "track your ride" map screen. */
guestRouter.get("/current-trip", async (req, res) => {
  const tripGuest = await prisma.tripGuest.findFirst({
    where: {
      guestId: guestId(req),
      trip: { status: { in: DRIVER_ACTIVE_TRIP_STATUSES } },
    },
    include: { trip: { include: { driver: true, guests: true } } },
  });
  if (!tripGuest) return res.json(null);
  const { trip } = tripGuest;
  res.json({
    trip,
    driver: trip.driver,
    nextStop: getNextStop(trip, trip.guests),
    myBoarded: tripGuest.boarded,
    myDroppedOff: tripGuest.droppedOff,
  });
});

const requestSchema = z.object({
  pickupLabel: z.string(),
  pickupLat: z.number(),
  pickupLng: z.number(),
  dropLabel: z.string(),
  dropLat: z.number(),
  dropLng: z.number(),
});

/** Guest raises an on-demand ride request. This does NOT go straight to
 * auto-allocation - it lands in Admin/Operations' approval queue first
 * (PENDING_APPROVAL). Once approved, the matching engine allocates a driver
 * automatically exactly as for scheduled pickups. */
guestRouter.post("/request", async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const guest = await prisma.guest.findUnique({ where: { id: guestId(req) } });
  if (!guest) return res.status(404).json({ error: "Guest not found" });

  const existingPending = await prisma.tripGuest.findFirst({
    where: { guestId: guest.id, trip: { status: { in: GUEST_BLOCKING_TRIP_STATUSES } } },
  });
  if (existingPending) {
    return res.status(409).json({ error: "You already have a pending or active ride request" });
  }

  const t = parsed.data;
  const trip = await prisma.trip.create({
    data: {
      type: "ON_DEMAND",
      origin: "ON_DEMAND",
      status: "PENDING_APPROVAL",
      pickupLabel: t.pickupLabel,
      pickupLat: t.pickupLat,
      pickupLng: t.pickupLng,
      dropLabel: t.dropLabel,
      dropLat: t.dropLat,
      dropLng: t.dropLng,
      totalSeats: guest.partySize,
      totalLuggage: guest.luggageCount,
      guests: { create: { guestId: guest.id, seats: guest.partySize, luggage: guest.luggageCount } },
    },
  });
  res.status(201).json(trip);
});

guestRouter.get("/places", requireAuth, async (_req, res) => {
  res.json(await prisma.place.findMany());
});
