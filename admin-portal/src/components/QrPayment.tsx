import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, ApiError } from "../api/client";
import { formatCents } from "../lib/format";

// A UPI payee address (e.g. "event@okicici") is a PUBLIC payment handle, not a
// secret - safe to ship in the client. Falls back to a demo value if unset.
const UPI_VPA = (import.meta.env.VITE_UPI_VPA as string | undefined) ?? "smartcab@upi";
const UPI_PAYEE = (import.meta.env.VITE_UPI_PAYEE_NAME as string | undefined) ?? "Smart Cab Dispatch";

/**
 * QR / UPI payment modal, offered alongside the Stripe "Pay now" flow. The
 * guest scans the QR with any UPI app, pays, then taps "I've completed
 * payment", which calls an idempotent backend endpoint that marks the SAME
 * TripGuest fare PAID (and credits the driver) exactly like the Stripe path.
 */
export function QrPayment({
  tripId,
  guestName,
  amountCents,
  onPaid,
  onCancel,
}: {
  tripId: string;
  guestName: string;
  amountCents: number;
  onPaid: () => void;
  onCancel: () => void;
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const ref = tripId.slice(-6).toUpperCase();
  const amountRupees = (amountCents / 100).toFixed(2);

  useEffect(() => {
    const note = `SCDS ride ${ref}`;
    const upi = `upi://pay?pa=${encodeURIComponent(UPI_VPA)}&pn=${encodeURIComponent(
      UPI_PAYEE
    )}&am=${amountRupees}&cu=INR&tn=${encodeURIComponent(note)}`;
    let cancelled = false;
    QRCode.toDataURL(upi, { width: 240, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrError("Couldn't generate the QR code. Please use Pay now instead.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  async function confirm() {
    // Guard against a double-tap on the client; the backend is idempotent too.
    if (confirming || done) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await api.post(`/guest/trips/${tripId}/confirm-qr-payment`);
      setDone(true);
      // brief success state, then let the parent refresh the payments UI
      setTimeout(onPaid, 1000);
    } catch (err) {
      setConfirmError(err instanceof ApiError ? err.message : "Couldn't confirm payment. Please try again.");
      setConfirming(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Pay via QR" onClick={onCancel}>
      <div className="modal qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qr-head">
          <h3>Pay via QR</h3>
          <button className="icon-btn" aria-label="Close" onClick={onCancel} disabled={confirming}>
            ×
          </button>
        </div>

        {done ? (
          <div className="qr-success">
            <div className="qr-check" aria-hidden="true">✓</div>
            <p><strong>Payment confirmed</strong></p>
            <p className="muted">Thank you! Updating your fare…</p>
          </div>
        ) : (
          <>
            <div className="qr-code-box">
              {qrDataUrl && <img src={qrDataUrl} alt="Scan to pay with any UPI app" width={240} height={240} />}
              {!qrDataUrl && !qrError && <div className="qr-skeleton" aria-label="Generating QR code" />}
              {qrError && <div className="error-banner">{qrError}</div>}
            </div>
            <p className="muted qr-hint">Scan with any UPI app (GPay, PhonePe, Paytm) to pay.</p>

            <dl className="qr-details">
              <div><dt>Amount</dt><dd className="qr-amount">{formatCents(amountCents)}</dd></div>
              <div><dt>Guest</dt><dd>{guestName}</dd></div>
              <div><dt>Booking ref</dt><dd>#{ref}</dd></div>
              <div><dt>Status</dt><dd><span className="status-pill">Awaiting payment</span></dd></div>
            </dl>

            {confirmError && <div className="error-banner">{confirmError}</div>}

            <div className="qr-actions">
              <button onClick={confirm} disabled={confirming || !!qrError}>
                {confirming ? "Confirming…" : "I've completed payment"}
              </button>
              <button className="secondary" onClick={onCancel} disabled={confirming}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
