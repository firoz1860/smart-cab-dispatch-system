import crypto from "crypto";

// Razorpay is an optional external dependency (like Stripe): UPI QR payments are
// only live when these are set. SERVER-SIDE ONLY - no Razorpay key is ever sent
// to the client. The browser only renders the hosted QR image URL the backend
// returns, so there is nothing secret to leak client-side.
const KEY_ID = process.env.RAZORPAY_KEY_ID?.trim();
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET?.trim();

export function isRazorpayConfigured(): boolean {
  return !!(KEY_ID && KEY_SECRET);
}

export function getRazorpayWebhookSecret(): string | undefined {
  const s = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  return s || undefined;
}

export interface RazorpayQrCode {
  id: string;
  image_url: string;
  payment_amount: number;
  status: string;
}

/**
 * Creates a single-use, fixed-amount UPI QR code via Razorpay's QR Codes API.
 * The amount and our booking reference (notes) are set here, server-side, and
 * are later echoed back - signed - in the webhook, so the client can never
 * tamper with what/how-much is being paid.
 */
export async function createUpiQrCode(params: {
  amountPaise: number;
  description: string;
  notes: Record<string, string>;
}): Promise<RazorpayQrCode> {
  if (!KEY_ID || !KEY_SECRET) throw new Error("Razorpay is not configured");
  const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/payments/qr_codes", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "upi_qr",
      usage: "single_use",
      fixed_amount: true,
      payment_amount: params.amountPaise,
      description: params.description,
      notes: params.notes,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Razorpay QR create failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as RazorpayQrCode;
}

/** Timing-safe HMAC-SHA256 verification of a raw Razorpay webhook body against
 * the x-razorpay-signature header, using the dashboard-configured webhook secret. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
