import { useEffect, useState, useCallback } from "react";
import { api, ApiError } from "../api/client";
import { getSocket } from "../api/socket";
import { useAuth } from "../auth/AuthContext";
import { MapView } from "../components/MapView";
import { formatDuration } from "../lib/format";
import { useLiveCountdown } from "../lib/useLiveCountdown";
import type { Guest, Trip, Place } from "../types";

function StatusLabel({ status }: { status: string }) {
  const labels: Record<string, string> = {
    PENDING_APPROVAL: "Waiting for admin approval",
    QUEUED: "Finding you a driver...",
    ASSIGNED: "Driver assigned - waiting for pickup confirmation",
    EN_ROUTE_PICKUP: "Driver is on the way",
    ARRIVED_PICKUP: "Driver has arrived",
    IN_PROGRESS: "On the way to your destination",
    COMPLETED: "Completed",
    DECLINED: "Request declined",
    UNASSIGNABLE: "Still searching for an available driver",
  };
  return <span className="status-pill">{labels[status] ?? status}</span>;
}

export function Dashboard() {
  const { session, logout } = useAuth();
  const [guest, setGuest] = useState<Guest | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [currentTrip, setCurrentTrip] = useState<{ trip: Trip; driver: Trip["driver"]; nextStop: any } | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [notification, setNotification] = useState<string | null>(null);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const interval = setInterval(refresh, 5000);
    if (session) {
      const socket = getSocket(session.token);
      socket.on("trip:matched", () => {
        setNotification("You've been matched with a driver! Check your ride details below.");
        refresh();
      });
      socket.on("trip:boarded", () => refresh());
      socket.on("trip:dropped", () => {
        setNotification("You've arrived at your destination.");
        refresh();
      });
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
        socket.off("trip:matched");
        socket.off("trip:boarded");
        socket.off("trip:dropped");
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
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🚕</span>
          <div className="brand-text">
            <span className="brand-title">Smart Cab Dispatch</span>
            <span className="brand-subtitle">Guest</span>
          </div>
        </div>
        <div className="user-chip">
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
              <StatusLabel status={currentTrip.trip.status} />
              {currentTrip.driver && (
                <div className="driver-info">
                  <p><strong>{currentTrip.driver.name}</strong> · {currentTrip.driver.vehicleNumber}</p>
                  {liveEtaSeconds != null && (
                    <p className="eta">ETA: ~{formatDuration(liveEtaSeconds)}</p>
                  )}
                </div>
              )}
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
              <RequestForm
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
            {upcoming.length === 0 && <p className="muted">No upcoming trips.</p>}
            <ul className="trip-list">
              {upcoming.map((t) => (
                <li key={t.id}>
                  <div>{t.pickupLabel} → {t.dropLabel}</div>
                  <StatusLabel status={t.status} />
                  {t.scheduledTime && <div className="muted">{new Date(t.scheduledTime).toLocaleString()}</div>}
                </li>
              ))}
            </ul>
          </div>

          {past.length > 0 && (
            <div className="card">
              <h3>Past trips</h3>
              <ul className="trip-list">
                {past.map((t) => (
                  <li key={t.id}>
                    <div>{t.pickupLabel} → {t.dropLabel}</div>
                    <StatusLabel status={t.status} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RequestForm({
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
