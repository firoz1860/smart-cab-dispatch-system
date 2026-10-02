import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { formatCents } from "../lib/format";

type Phase = "loading" | "pending" | "paid" | "error" | "unconfigured";

interface QrOrder {
  qrId: string;
  qrImageUrl: string;
  amountCents: number;
  reference: string;
  status: string;
}

/**
 * Real UPI QR payment modal (Razorpay). On open it asks the backend to create a
 * Razorpay QR order and renders Razorpay's hosted QR image. The fare stays
 * PENDING and the modal polls the server for status; it flips to PAID ONLY after
 * Razorpay's signed webhook has verified the payment server-side. There is no
 * "I've paid" trust button and no secret key in the client.
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
  const [phase, setPhase] = useState<Phase>("loading");
  const [order, setOrder] = useState<QrOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const paidRef = useRef(false);

  const reference = order?.reference ?? tripId.slice(-6).toUpperCase();

  function markPaid() {
    if (paidRef.current) return;
    paidRef.current = true;
    if (pollRef.current) clearInterval(pollRef.current);
    setPhase("paid");
    setTimeout(onPaid, 1200);
  }

  async function checkStatus() {
    try {
      const res = await api.get<{ status: string }>(`/guest/trips/${tripId}/payment-status`);
      if (res.status === "PAID") markPaid();
    } catch {
      /* transient - keep polling */
    }
  }

  // 1) Create the Razorpay QR order when the modal opens.
  useEffect(() => {
    let cancelled = false;
    api
      .post<QrOrder & { status: string }>(`/guest/trips/${tripId}/qr-order`)
      .then((res) => {
        if (cancelled) return;
        if (res.status === "PAID") {
          markPaid();
          return;
        }
        setOrder(res as QrOrder);
        setPhase("pending");
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 503) {
          setPhase("unconfigured");
          return;
        }
        setError(err instanceof ApiError ? err.message : "Couldn't start the QR payment.");
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  // 2) While pending, poll the server-verified status every 3s.
  useEffect(() => {
    if (phase !== "pending") return;
    pollRef.current = setInterval(checkStatus, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function manualCheck() {
    setChecking(true);
    await checkStatus();
    setChecking(false);
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Pay via UPI QR" onClick={onCancel}>
      <div className="modal qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qr-head">
          <h3>Pay via UPI QR</h3>
          <button className="icon-btn" aria-label="Close" onClick={onCancel}>×</button>
        </div>

        {phase === "paid" ? (
          <div className="qr-success">
            <div className="qr-check" aria-hidden="true">✓</div>
            <p><strong>Payment verified</strong></p>
            <p className="muted">Thank you! Updating your fare…</p>
          </div>
        ) : phase === "unconfigured" ? (
          <div className="empty-state">
            <p className="muted">
              UPI QR payments aren't set up for this event yet. Please use <strong>Pay now</strong> (card) instead.
            </p>
            <div className="qr-actions"><button className="secondary" onClick={onCancel}>Close</button></div>
          </div>
        ) : phase === "error" ? (
          <>
            <div className="error-banner">{error}</div>
            <div className="qr-actions"><button className="secondary" onClick={onCancel}>Close</button></div>
          </>
        ) : (
          <>
            <div className="qr-code-box">
              {order?.qrImageUrl ? (
                <img src={order.qrImageUrl} alt="Scan to pay with any UPI app" />
              ) : (
                <div className="qr-skeleton" aria-label="Generating QR code" />
              )}
            </div>
            <p className="muted qr-hint">Scan with any UPI app (GPay, PhonePe, Paytm) and pay — we'll confirm automatically.</p>

            <dl className="qr-details">
              <div><dt>Amount</dt><dd className="qr-amount">{formatCents(order?.amountCents ?? amountCents)}</dd></div>
              <div><dt>Guest</dt><dd>{guestName}</dd></div>
              <div><dt>Booking ref</dt><dd>#{reference}</dd></div>
              <div>
                <dt>Status</dt>
                <dd><span className="status-pill status-pending">Pending · awaiting payment</span></dd>
              </div>
            </dl>

            <div className="qr-actions">
              <button onClick={manualCheck} disabled={checking || phase === "loading"}>
                {checking ? "Checking…" : "Refresh status"}
              </button>
              <button className="secondary" onClick={onCancel}>Cancel</button>
            </div>
            <p className="muted qr-foot">
              The fare stays <strong>Pending</strong> until your bank/UPI confirms the payment to us — closing this won't mark it paid.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
