import { useEffect, useState, useCallback, lazy, Suspense } from "react";
import { api, ApiError } from "../api/client";
import { getSocket } from "../api/socket";
import { useAuth } from "../auth/AuthContext";
import { formatDuration, formatCents } from "../lib/format";
import { useLiveCountdown } from "../lib/useLiveCountdown";
import { requestNotificationPermission, notify } from "../lib/pushNotify";
import type { Guest, Trip, Place } from "../types";

// Heavy, rarely-needed deps as their own chunks: Leaflet (only with an active
// ride) and Stripe (only when paying) stay out of the initial bundle.
const MapView = lazy(() => import("../components/MapView").then((m) => ({ default: m.MapView })));
const PaymentForm = lazy(() => import("../components/PaymentForm").then((m) => ({ default: m.PaymentForm })));
const QrPayment = lazy(() => import("../components/QrPayment").then((m) => ({ default: m.QrPayment })));

const TRIP_TYPE_LABELS: Record<string, string> = {
  ARRIVAL: "Arrival",
  TO_VENUE: "To venue",
  RETURN: "Return",
  DEPARTURE: "Departure",
  ON_DEMAND: "On-demand",
};

function scheduledTimeLabel(type: string): string {
  if (type === "ARRIVAL") return "Scheduled arrival";
  if (type === "DEPARTURE") return "Scheduled departure";
  return "Scheduled pickup";
}

function GuestStatusLabel({ status }: { status: string }) {
  const labels: Record<string, string> = {
    PENDING_APPROVAL: "Waiting for admin approval",
    QUEUED: "Finding you a driver...",
    ASSIGNED: "Driver assigned - waiting for pickup confirmation",
    EN_ROUTE_PICKUP: "Driver is on the way",
    ARRIVED_PICKUP: "Driver has arrived",
    IN_PROGRESS: "On the way to your destination",
    ARRIVED_DROP: "Driver has arrived at your destination",
    COMPLETED: "Completed",
    DECLINED: "Request declined",
    UNASSIGNABLE: "Still searching for an available driver",
  };
  return <span className="status-pill">{labels[status] ?? status}</span>;
}

// A guest's ride moves through a fixed sequence of milestones. Showing it as a
// timeline (what's done, what's happening now, what's next) is far more
// reassuring than a single status word - the traveler can see exactly where
// they are in the journey.
const RIDE_STEPS = [
  "Requested",
  "Finding your driver",
  "Driver assigned",
  "Driver on the way",
  "Driver arrived",
  "On your way",
  "Arrived at destination",
];

function rideStepIndex(status: string): number {
  switch (status) {
    case "PENDING_APPROVAL": return 0;
    case "QUEUED":
    case "UNASSIGNABLE": return 1;
    case "ASSIGNED": return 2;
    case "EN_ROUTE_PICKUP": return 3;
    case "ARRIVED_PICKUP": return 4;
    case "IN_PROGRESS": return 5;
    case "ARRIVED_DROP": return 6;
    case "COMPLETED": return 7;
    default: return 0;
  }
}

function RideTimeline({ status }: { status: string }) {
  const idx = rideStepIndex(status);
  return (
    <ul className="timeline">
      {RIDE_STEPS.map((label, i) => (
        <li key={label} className={i < idx ? "done" : i === idx ? "current" : ""}>
          {label}
        </li>
      ))}
    </ul>
  );
}

export function GuestDashboard() {
  const { session, logout } = useAuth();
  const [guest, setGuest] = useState<Guest | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [currentTrip, setCurrentTrip] = useState<{ trip: Trip; driver: Trip["driver"]; nextStop: any } | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [notification, setNotification] = useState<string | null>(null);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payingTripId, setPayingTripId] = useState<string | null>(null);
  const [qrTripId, setQrTripId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [g, t, c, p] = await Promise.all([
        api.get<Guest>("/guest/me"),
        api.get<Trip[]>("/guest/trips"),
        api.get<{ trip: Trip; driver: Trip["driver"]; nextStop: any } | null>("/guest/current-trip"),
        api.get<Place[]>("/guest/places"),
      ]);
      setGuest(g);
      setTrips(t);
      setCurrentTrip(c);
      setPlaces(p);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    requestNotificationPermission();
    // Live updates arrive over the socket; this is a light fallback and
    // cold-start/reconnect safety-net poll, not the primary update path.
    const interval = setInterval(refresh, 20000);
    if (session) {
      const socket = getSocket();
      socket.on("connect", refresh);
      socket.on("trip:matched", () => {
        setNotification("You've been matched with a driver! Check your ride details below.");
        notify("Driver matched", "You've been matched with a driver - check your ride details.");
        refresh();
      });
      socket.on("trip:boarded", () => refresh());
      socket.on("trip:dropped", () => {
        setNotification("You've arrived at your destination.");
        notify("Trip complete", "You've arrived at your destination.");
        refresh();
      });
      socket.on("trip:driver-arrived-pickup", () => {
        setNotification("Your driver has arrived! Please head to the pickup point.");
        notify("Driver has arrived", "Please head to the pickup point.");
        refresh();
      });
      socket.on("trip:driver-arrived-drop", () => refresh());
      socket.on("payment:updated", () => refresh());
      socket.on(
        "driver:location",
        (data: { driverId: string; lat: number; lng: number; etaSeconds: number | null }) => {
          setCurrentTrip((prev) => {
            if (!prev || !prev.driver || prev.driver.id !== data.driverId) return prev;
            return {
              ...prev,
              driver: { ...prev.driver, currentLat: data.lat, currentLng: data.lng },
              trip: { ...prev.trip, etaSeconds: data.etaSeconds ?? prev.trip.etaSeconds },
            };
          });
        }
      );
      return () => {
        clearInterval(interval);
        socket.off("connect", refresh);
        socket.off("trip:matched");
        socket.off("trip:boarded");
        socket.off("trip:dropped");
        socket.off("trip:driver-arrived-pickup");
        socket.off("trip:driver-arrived-drop");
        socket.off("payment:updated");
        socket.off("driver:location");
      };
    }
    return () => clearInterval(interval);
  }, [refresh, session]);

  const liveEtaSeconds = useLiveCountdown(currentTrip?.trip.etaSeconds);

  const GUEST_BLOCKING_STATUSES = ["PENDING_APPROVAL", "QUEUED", "ASSIGNED", "EN_ROUTE_PICKUP", "ARRIVED_PICKUP", "IN_PROGRESS"];
  const hasPendingOrQueued = trips.some((t) => GUEST_BLOCKING_STATUSES.includes(t.status));
  const upcoming = trips.filter((t) =>
    ["QUEUED", "ASSIGNED", "EN_ROUTE_PICKUP", "ARRIVED_PICKUP", "IN_PROGRESS", "PENDING_APPROVAL", "UNASSIGNABLE"].includes(t.status)
  );
  const past = trips.filter((t) => ["COMPLETED", "DECLINED"].includes(t.status));

  return (
    <div className="app-shell guest-app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🚕</span>
          <div className="brand-text">
            <span className="brand-title">Smart Cab Dispatch</span>
            <span className="brand-subtitle">Guest</span>
          </div>
        </div>
        <div className="user-chip">
          <span className="user-avatar">{session?.name?.[0]?.toUpperCase() ?? "G"}</span>
          <span className="user-name">{session?.name}</span>
          <button className="logout-btn" onClick={logout}>Log out</button>
        </div>
      </header>

      {notification && (
        <div className="notification-banner" onClick={() => setNotification(null)}>
          🔔 {notification}
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}

      <div className="guest-layout">
        <div className="guest-col">
          <div className="card">
            <h3>Hi {guest?.name?.split(" ")[0]} 👋</h3>
            <p className="muted">
              Party of {guest?.partySize} · {guest?.luggageCount} bag(s)
              {guest?.accommodation && <> · Staying at <strong>{guest.accommodation.name}</strong></>}
            </p>
          </div>

          {currentTrip && (
            <div className="card highlight">
              <h3>Your ride</h3>
              <p className="muted">
                {TRIP_TYPE_LABELS[currentTrip.trip.type] ?? currentTrip.trip.type} · {currentTrip.trip.pickupLabel} → {currentTrip.trip.dropLabel}
              </p>
              <GuestStatusLabel status={currentTrip.trip.status} />
              {currentTrip.driver && (
                <div className="driver-info">
                  <p><strong>{currentTrip.driver.name}</strong> · {currentTrip.driver.vehicleNumber}</p>
                  {liveEtaSeconds != null && (
                    <p className="eta">ETA: ~{formatDuration(liveEtaSeconds)}</p>
                  )}
                </div>
              )}
              <RideTimeline status={currentTrip.trip.status} />
              <div className="map-frame">
                <Suspense fallback={<div className="map-skeleton" />}>
                  <MapView
                    center={[currentTrip.trip.pickupLat, currentTrip.trip.pickupLng]}
                    markers={[
                      { id: "pickup", lat: currentTrip.trip.pickupLat, lng: currentTrip.trip.pickupLng, label: currentTrip.trip.pickupLabel, variant: "place" },
                      { id: "drop", lat: currentTrip.trip.dropLat, lng: currentTrip.trip.dropLng, label: currentTrip.trip.dropLabel, variant: "place" },
                      ...(currentTrip.driver
                        ? [{ id: "driver", lat: currentTrip.driver.currentLat, lng: currentTrip.driver.currentLng, label: "Your driver", variant: "driver" as const }]
                        : []),
                    ]}
                  />
                </Suspense>
              </div>
            </div>
          )}
        </div>

        <div className="guest-col">
          <div className="card">
            <div className="row-between">
              <h3>Request a ride</h3>
              {!showRequestForm && (
                <button onClick={() => setShowRequestForm(true)} disabled={hasPendingOrQueued}>
                  New request
                </button>
              )}
            </div>
            {hasPendingOrQueued && !showRequestForm && (
              <p className="muted">You already have a request in progress — see below.</p>
            )}
            {showRequestForm && (
              <GuestRequestForm
                places={places}
                onCancel={() => setShowRequestForm(false)}
                onSubmitted={() => {
                  setShowRequestForm(false);
                  refresh();
                }}
              />
            )}
          </div>

          <div className="card">
            <h3>Upcoming</h3>
            {upcoming.length === 0 && (
              <div className="empty-state">
                <span className="empty-emoji" aria-hidden="true">🗓️</span>
                <p className="muted">No upcoming trips. Request a ride above whenever you're ready to go.</p>
              </div>
            )}
            <ul className="trip-list">
              {upcoming.map((t) => (
                <li key={t.id}>
                  <div className="muted">{TRIP_TYPE_LABELS[t.type] ?? t.type}</div>
                  <div>{t.pickupLabel} → {t.dropLabel}</div>
                  <GuestStatusLabel status={t.status} />
                  {t.scheduledTime && (
                    <div className="muted">{scheduledTimeLabel(t.type)}: {new Date(t.scheduledTime).toLocaleString()}</div>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {past.length > 0 && (
            <div className="card">
              <h3>Past trips</h3>
              <ul className="trip-list">
                {past.map((t) => {
                  const owesPayment = t.myFareAmountCents != null && t.myPaymentStatus !== "PAID";
                  return (
                    <li key={t.id}>
                      <div className="muted">{TRIP_TYPE_LABELS[t.type] ?? t.type}</div>
                      <div>{t.pickupLabel} → {t.dropLabel}</div>
                      <GuestStatusLabel status={t.status} />
                      {t.myFareAmountCents != null && (
                        <div className="row-between trip-payment-row">
                          <span>
                            Fare: <strong>{formatCents(t.myFareAmountCents)}</strong>
                            {t.myPaymentStatus === "PAID" && " · Paid"}
                            {t.myPaymentStatus === "FAILED" && " · Payment failed"}
                          </span>
                          {owesPayment && payingTripId !== t.id && (
                            <div className="button-row">
                              <button onClick={() => { setPayingTripId(t.id); setQrTripId(null); }}>Pay now</button>
                              <button className="secondary" onClick={() => { setQrTripId(t.id); setPayingTripId(null); }}>
                                Pay via QR
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                      {payingTripId === t.id && (
                        <div className="trip-payment-form">
                          <Suspense fallback={<p className="muted">Loading payment…</p>}>
                            <PaymentForm
                              tripId={t.id}
                              onPaid={() => {
                                setPayingTripId(null);
                                setNotification("Payment received - thank you!");
                                refresh();
                              }}
                            />
                          </Suspense>
                          <button className="secondary" onClick={() => setPayingTripId(null)}>
                            Cancel
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>

      {qrTripId && (() => {
        const qt = past.find((t) => t.id === qrTripId);
        if (!qt || qt.myFareAmountCents == null) return null;
        return (
          <Suspense fallback={null}>
            <QrPayment
              tripId={qt.id}
              guestName={guest?.name ?? session?.name ?? "Guest"}
              amountCents={qt.myFareAmountCents}
              onCancel={() => setQrTripId(null)}
              onPaid={() => {
                setQrTripId(null);
                setNotification("Payment received - thank you!");
                refresh();
              }}
            />
          </Suspense>
        );
      })()}
    </div>
  );
}

function GuestRequestForm({
  places,
  onCancel,
  onSubmitted,
}: {
  places: Place[];
  onCancel: () => void;
  onSubmitted: () => void;
}) {
  const [pickupId, setPickupId] = useState("");
  const [dropId, setDropId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const pickup = places.find((p) => p.id === pickupId);
    const drop = places.find((p) => p.id === dropId);
    if (!pickup || !drop) {
      setFormError("Choose both a pickup and a drop location.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await api.post("/guest/request", {
        pickupLabel: pickup.name,
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        dropLabel: drop.name,
        dropLat: drop.lat,
        dropLng: drop.lng,
      });
      onSubmitted();
    } catch (err) {
      if (err instanceof ApiError) setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="stacked-form">
      <label>
        Pickup from
        <select required value={pickupId} onChange={(e) => setPickupId(e.target.value)}>
          <option value="">— select —</option>
          {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label>
        Drop at
        <select required value={dropId} onChange={(e) => setDropId(e.target.value)}>
          <option value="">— select —</option>
          {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {formError && <div className="error-banner">{formError}</div>}
      <p className="muted">Your request goes to Admin/Operations for approval before a driver is auto-assigned.</p>
      <div className="button-row">
        <button type="submit" disabled={submitting}>Submit request</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
