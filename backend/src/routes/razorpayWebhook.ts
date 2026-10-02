import { Router } from "express";
import { prisma } from "../lib/prisma";
import { getRazorpayWebhookSecret, verifyWebhookSignature } from "../lib/razorpayClient";
import { DRIVER_FARE_SHARE } from "../lib/constants";
import { emitToGuest, emitDispatchEvent } from "../realtime/socket";

export const razorpayWebhookRouter = Router();

/**
 * Razorpay webhook - the authoritative source of truth for UPI QR payments,
 * exactly like the Stripe webhook is for cards. A fare is only ever marked PAID
 * here, never from a client "I've paid" click.
 *
 * Mounted with express.raw() BEFORE the global express.json() (see server.ts),
 * because the HMAC-SHA256 signature is computed over the exact raw bytes.
 *
 * Safety properties:
 *  - Signature verified against RAZORPAY_WEBHOOK_SECRET (rejects forgeries).
 *  - Amount must equal the stored fare exactly (rejects tampered/partial pays).
 *  - Booking matched via our own `notes.tripGuestId`, which we set server-side.
 *  - Idempotent: the PAID transition only fires while UNPAID/PENDING, inside the
 *    same transaction as the driver credit - so duplicate deliveries (Razorpay
 *    guarantees at-least-once) can't double-credit the driver.
 */
razorpayWebhookRouter.post("/", async (req, res) => {
  const secret = getRazorpayWebhookSecret();
  if (!secret) return res.status(503).json({ error: "Razorpay webhooks are not configured" });

  const signature = req.headers["x-razorpay-signature"] as string | undefined;
  const raw = req.body as Buffer; // express.raw() yields a Buffer
  if (!Buffer.isBuffer(raw) || !verifyWebhookSignature(raw, signature, secret)) {
    console.error("[payments] Razorpay webhook signature verification failed");
    return res.status(400).json({ error: "Invalid signature" });
  }

  let event: {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; amount?: number } };
      qr_code?: { entity?: { id?: string; notes?: Record<string, string> } };
    };
  };
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid body" });
  }

  // We only act on a successful QR credit; any other event is acked and ignored.
  if (event.event === "qr_code.credited") {
    const payment = event.payload?.payment?.entity;
    const qr = event.payload?.qr_code?.entity;
    const tripGuestId = qr?.notes?.tripGuestId;
    const paidAmount = payment?.amount; // paise
    const paymentRef = payment?.id;

    if (tripGuestId && typeof paidAmount === "number") {
      const applied = await prisma.$transaction(async (tx) => {
        const tg = await tx.tripGuest.findUnique({ where: { id: tripGuestId } });
        if (!tg || tg.fareAmountCents == null) return null;

        // Never mark PAID unless the paid amount matches the fare exactly.
        if (paidAmount !== tg.fareAmountCents) {
          console.error(
            `[payments] Razorpay amount mismatch for TripGuest ${tripGuestId} (payment ${paymentRef}): paid ${paidAmount}, expected ${tg.fareAmountCents}`
          );
          return null;
        }

        const { count } = await tx.tripGuest.updateMany({
          where: { id: tg.id, paymentStatus: { in: ["UNPAID", "PENDING"] } },
          data: { paymentStatus: "PAID", paidAt: new Date() },
        });
        if (count === 0) return null; // already processed by an earlier delivery - nothing to do

        const trip = await tx.trip.findUnique({ where: { id: tg.tripId } });
        if (trip?.driverId) {
          const driverShareCents = Math.round(tg.fareAmountCents * DRIVER_FARE_SHARE);
          await tx.driver.update({
            where: { id: trip.driverId },
            data: { totalEarningsCents: { increment: driverShareCents } },
          });
        }
        return tg;
      });

      if (applied) {
        emitToGuest(applied.guestId, "payment:updated", { tripId: applied.tripId, status: "PAID" });
        emitDispatchEvent("payment:updated", { tripGuestId: applied.id, status: "PAID" });
      }
    }
  }

  res.json({ received: true });
});
