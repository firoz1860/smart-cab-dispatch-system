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
    const paid = event.type === "payment_intent.succeeded";

    // Stripe explicitly guarantees only "at least once" delivery - the same
    // event can and does arrive more than once (retries after a timeout,
    // network blips, etc), and two deliveries could even be in flight
    // concurrently. Without a guard, a redelivered payment_intent.succeeded
    // would credit the driver's earnings ledger a second time for the same
    // fare. `updateMany`'s WHERE re-checks paymentStatus is still
    // PENDING/UNPAID *at write time* (not just at the read above), inside
    // the same transaction as the driver credit - so only whichever request
    // actually wins the transition gets to run the credit, and it's atomic
    // with that transition (a crash between the two is impossible; they
    // commit or roll back together).
    const applied = await prisma.$transaction(async (tx) => {
      const tripGuest = await tx.tripGuest.findUnique({ where: { stripePaymentIntentId: intent.id } });
      if (!tripGuest) return null;

      const { count } = await tx.tripGuest.updateMany({
        where: { id: tripGuest.id, paymentStatus: { in: ["PENDING", "UNPAID"] } },
        data: { paymentStatus: paid ? "PAID" : "FAILED", paidAt: paid ? new Date() : null },
      });
      if (count === 0) return null; // already processed by an earlier delivery of this event - nothing to do

      if (paid && tripGuest.fareAmountCents) {
        const trip = await tx.trip.findUnique({ where: { id: tripGuest.tripId } });
        if (trip?.driverId) {
          const driverShareCents = Math.round(tripGuest.fareAmountCents * DRIVER_FARE_SHARE);
          await tx.driver.update({
            where: { id: trip.driverId },
            data: { totalEarningsCents: { increment: driverShareCents } },
          });
        }
      }
      return tripGuest;
    });

    if (applied) {
      emitToGuest(applied.guestId, "payment:updated", { tripId: applied.tripId, status: paid ? "PAID" : "FAILED" });
      emitDispatchEvent("payment:updated", { tripGuestId: applied.id, status: paid ? "PAID" : "FAILED" });
    }
  }

  res.json({ received: true });
});
