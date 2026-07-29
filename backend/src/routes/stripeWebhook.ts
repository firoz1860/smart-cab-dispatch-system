import { Router } from "express";
import type Stripe from "stripe";
import { prisma } from "../lib/prisma";
import { getStripe } from "../lib/stripeClient";
import { DRIVER_FARE_SHARE } from "../lib/constants";
import { emitToGuest, emitDispatchEvent } from "../realtime/socket";

export const stripeWebhookRouter = Router();

/** Stripe webhook receiver - the authoritative source of truth for payment
 * status. Never trust client-side "payment succeeded" callbacks alone (a
 * closed tab, network drop, or malicious client could skip them); this is
 * what actually marks a fare PAID and credits the driver's earnings ledger.
 * Mounted with express.raw() in server.ts, BEFORE the global JSON body
 * parser, since Stripe's signature verification needs the exact raw bytes. */
stripeWebhookRouter.post("/", async (req, res) => {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!stripe || !webhookSecret) {
    return res.status(503).json({ error: "Stripe webhooks are not configured" });
  }

  const signature = req.headers["stripe-signature"];
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature as string, webhookSecret);
  } catch (err) {
    console.error("[payments] webhook signature verification failed:", err);
    return res.status(400).json({ error: "Invalid signature" });
  }

  if (event.type === "payment_intent.succeeded" || event.type === "payment_intent.payment_failed") {
    const intent = event.data.object as Stripe.PaymentIntent;
    const tripGuest = await prisma.tripGuest.findFirst({ where: { stripePaymentIntentId: intent.id } });

    if (tripGuest) {
      const paid = event.type === "payment_intent.succeeded";
      await prisma.tripGuest.update({
        where: { id: tripGuest.id },
        data: { paymentStatus: paid ? "PAID" : "FAILED", paidAt: paid ? new Date() : null },
      });

      if (paid && tripGuest.fareAmountCents) {
        const trip = await prisma.trip.findUnique({ where: { id: tripGuest.tripId } });
        if (trip?.driverId) {
          const driverShareCents = Math.round(tripGuest.fareAmountCents * DRIVER_FARE_SHARE);
          await prisma.driver.update({
            where: { id: trip.driverId },
            data: { totalEarningsCents: { increment: driverShareCents } },
          });
        }
      }

      emitToGuest(tripGuest.guestId, "payment:updated", {
        tripId: tripGuest.tripId,
        status: paid ? "PAID" : "FAILED",
      });
      emitDispatchEvent("payment:updated", { tripGuestId: tripGuest.id, status: paid ? "PAID" : "FAILED" });
    }
  }

  res.json({ received: true });
});
