import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { getNextStop } from "../engine/stops";
import { GUEST_BLOCKING_TRIP_STATUSES, DRIVER_ACTIVE_TRIP_STATUSES } from "../lib/constants";
import { getStripe } from "../lib/stripeClient";
import { isRazorpayConfigured, createUpiQrCode } from "../lib/razorpayClient";

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

/**
 * Start a REAL UPI QR payment: creates a single-use, fixed-amount Razorpay QR
 * for this fare and moves it to PENDING. The fare is NOT marked paid here - it
 * only becomes PAID when Razorpay's signed webhook confirms the money actually
 * arrived (see routes/razorpayWebhook.ts). The frontend never confirms payment.
 */
guestRouter.post("/trips/:tripId/qr-order", async (req, res) => {
  const tripGuest = await prisma.tripGuest.findUnique({
    where: { tripId_guestId: { tripId: req.params.tripId, guestId: guestId(req) } },
  });
  if (!tripGuest) return res.status(404).json({ error: "Trip not found" });
  if (tripGuest.fareAmountCents == null) {
    return res.status(400).json({ error: "No fare has been calculated for this trip yet" });
  }
  if (tripGuest.paymentStatus === "PAID") return res.json({ status: "PAID" });
  if (!isRazorpayConfigured()) {
    return res.status(503).json({ error: "UPI QR payments are not configured for this event yet" });
  }

  try {
    const reference = tripGuest.id.slice(-6).toUpperCase();
    const qr = await createUpiQrCode({
      amountPaise: tripGuest.fareAmountCents,
      description: `SCDS ride ${reference}`,
      notes: { tripId: tripGuest.tripId, tripGuestId: tripGuest.id, guestId: tripGuest.guestId },
    });
    // Reflect that a payment is now in flight. Only ever UNPAID -> PENDING here;
    // the webhook owns the PENDING/UNPAID -> PAID transition.
    await prisma.tripGuest.updateMany({
      where: { id: tripGuest.id, paymentStatus: "UNPAID" },
      data: { paymentStatus: "PENDING" },
    });
    res.status(201).json({
      qrId: qr.id,
      qrImageUrl: qr.image_url,
      amountCents: tripGuest.fareAmountCents,
      reference,
      status: "PENDING",
    });
  } catch (err) {
    console.error("[payments] failed to create Razorpay QR:", err);
    res.status(502).json({ error: "Couldn't start the QR payment. Please try again or use Pay now." });
  }
});

/** Lightweight status poll for the QR modal: returns this guest's fare status
 * so the UI can show PENDING until the signed webhook flips it to PAID. */
guestRouter.get("/trips/:tripId/payment-status", async (req, res) => {
  const tripGuest = await prisma.tripGuest.findUnique({
    where: { tripId_guestId: { tripId: req.params.tripId, guestId: guestId(req) } },
    select: { paymentStatus: true, fareAmountCents: true },
  });
  if (!tripGuest) return res.status(404).json({ error: "Trip not found" });
  res.json({ status: tripGuest.paymentStatus, fareAmountCents: tripGuest.fareAmountCents });
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
