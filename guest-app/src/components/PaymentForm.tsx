import { useEffect, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { api, ApiError } from "../api/client";

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;
let stripePromise: Promise<Stripe | null> | null = null;

function getStripePromise(): Promise<Stripe | null> | null {
  if (!publishableKey) return null;
  if (!stripePromise) stripePromise = loadStripe(publishableKey);
  return stripePromise;
}

export function isPaymentsEnabled(): boolean {
  return !!publishableKey;
}

interface PaymentIntentResponse {
  clientSecret: string | null;
  fareAmountCents: number | null;
  paymentStatus: string;
}

function CheckoutForm({ onPaid }: { onPaid: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
    });

    if (confirmError) {
      setError(confirmError.message ?? "Payment failed. Please try again.");
      setSubmitting(false);
      return;
    }
    if (paymentIntent && (paymentIntent.status === "succeeded" || paymentIntent.status === "processing")) {
      onPaid();
    }
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="stacked-form">
      <PaymentElement />
      {error && <div className="error-banner">{error}</div>}
      <button type="submit" disabled={!stripe || submitting}>
        {submitting ? "Processing..." : "Pay now"}
      </button>
    </form>
  );
}

/** Collects payment for a single completed trip's fare via Stripe Elements.
 * Renders nothing usable if Stripe isn't configured (no publishable key) -
 * the fare is still visible elsewhere, it just can't be paid from the app. */
export function PaymentForm({ tripId, onPaid }: { tripId: string; onPaid: () => void }) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<PaymentIntentResponse>(`/guest/trips/${tripId}/payment`)
      .then((res) => {
        if (cancelled) return;
        if (res.paymentStatus === "PAID") {
          onPaid();
          return;
        }
        setClientSecret(res.clientSecret);
      })
      .catch((err) => {
        if (!cancelled && err instanceof ApiError) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  const promise = getStripePromise();
  if (!promise) return <p className="muted">Payments aren't set up for this event yet.</p>;
  if (error) return <div className="error-banner">{error}</div>;
  if (loading || !clientSecret) return <p className="muted">Loading payment form...</p>;

  return (
    <Elements stripe={promise} options={{ clientSecret }}>
      <CheckoutForm onPaid={onPaid} />
    </Elements>
  );
}
