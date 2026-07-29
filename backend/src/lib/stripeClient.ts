import Stripe from "stripe";

// Same "optional external dependency" pattern as distanceProvider.ts's
// Google Maps key: payments are only live if STRIPE_SECRET_KEY is set (a
// free Stripe test-mode key, no business verification required). Without
// it, fares are still computed and shown, but nothing can actually be
// charged - see docs/DESIGN.md "Payments" for the full boundary.
let stripe: Stripe | null | undefined;

export function getStripe(): Stripe | null {
  if (stripe !== undefined) return stripe;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  stripe = key ? new Stripe(key) : null;
  return stripe;
}

export function isStripeConfigured(): boolean {
  return getStripe() !== null;
}
