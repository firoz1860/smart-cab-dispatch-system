import { useEffect, useState, useCallback, useRef } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { MapView } from "../components/MapView";
import type { Driver, Trip } from "../types";

interface Stop {
  phase: "pickup" | "drop";
  label: string;
  lat: number;
  lng: number;
  stopOrder: number;
  tripGuestIds: string[];
}

interface TripResponse {
  trip: Trip;
  nextStop: Stop | null;
  stops: { phase: string; label: string; lat: number; lng: number; guestId: string; done: boolean }[];
}

export function DriverView() {
  const { session, logout } = useAuth();
  const [me, setMe] = useState<Driver | null>(null);
  const [tripData, setTripData] = useState<TripResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const watchIdRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [driver, trip] = await Promise.all([
        api.get<Driver>("/driver/me"),
        api.get<TripResponse | null>("/driver/trip"),
      ]);
      setMe(driver);
      setTripData(trip);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function goOnline() {
    await api.post("/driver/status", { status: "AVAILABLE" });
    refresh();
  }
  async function goOffline() {
    stopSharing();
    await api.post("/driver/status", { status: "OFFLINE" });
    refresh();
  }

  function startSharing() {
    if (!navigator.geolocation) {
      setError("Geolocation is not available in this browser.");
      return;
    }
    setSharing(true);
    watchIdRef.current = navigator.geolocation.watchPosition(
      async (pos) => {
        await api.post("/driver/location", { lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(() => {});
      },
      () => setError("Could not read GPS location."),
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  }
  function stopSharing() {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = null;
    setSharing(false);
  }

  async function accept(tripId: string) {
    await api.post(`/driver/trip/${tripId}/accept`);
    refresh();
  }
  async function reject(tripId: string) {
    if (!window.confirm("Reject this trip? It will be re-queued for another driver.")) return;
    await api.post(`/driver/trip/${tripId}/reject`);
    refresh();
  }
  async function advance(tripId: string) {
    await api.post(`/driver/trip/${tripId}/advance`);
    refresh();
  }

  const trip = tripData?.trip;
  const next = tripData?.nextStop;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🚕</span>
          <div className="brand-text">
            <span className="brand-title">Smart Cab Dispatch</span>
            <span className="brand-subtitle">Driver</span>
          </div>
        </div>
        <div className="user-chip">
          <span className="user-name">{session?.name}</span>
          <button className="logout-btn" onClick={logout}>Log out</button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h3>Your status: {me?.status}</h3>
        <div className="button-row">
          {me?.status === "OFFLINE" ? (
            <button onClick={goOnline}>Go online</button>
          ) : (
            <button className="danger" onClick={goOffline} disabled={!!trip}>
              Go offline
            </button>
          )}
          {!sharing ? (
            <button onClick={startSharing}>Start sharing live location</button>
          ) : (
            <button className="danger" onClick={stopSharing}>Stop sharing location</button>
          )}
        </div>
        {me?.status === "ON_BREAK" && <p className="muted">On mandatory rest break until {me.freeAt ? new Date(me.freeAt).toLocaleTimeString() : "—"}.</p>}
      </div>

      {!trip && (
        <div className="card">
          <p className="muted">No trip assigned right now. You'll be notified the moment the dispatch engine matches you with a guest.</p>
        </div>
      )}

      {trip && (
        <div className="grid-2">
          <div className="card">
            <h3>Current trip — {trip.status.replace(/_/g, " ")}</h3>
            <p><strong>{trip.totalSeats}</strong> guest seat(s), <strong>{trip.totalLuggage}</strong> bag(s)</p>
            {next && (
              <div className="next-stop">
                <span className="badge" style={{ background: next.phase === "pickup" ? "#c9820a" : "#2563eb" }}>
                  {next.phase === "pickup" ? "Next: Pick up" : "Next: Drop off"}
                </span>
                <p>{next.label}</p>
              </div>
            )}
            <h4>All stops</h4>
            <ul className="stop-list">
              {tripData?.stops.map((s, i) => (
                <li key={i} className={s.done ? "done" : ""}>
                  {s.phase === "pickup" ? "Pick up" : "Drop"} — {s.label} {s.done ? "✓" : ""}
                </li>
              ))}
            </ul>
            <div className="button-row">
              {trip.status === "ASSIGNED" && (
                <>
                  <button onClick={() => accept(trip.id)}>Accept trip</button>
                  <button className="danger" onClick={() => reject(trip.id)}>Reject</button>
                </>
              )}
              {trip.status !== "ASSIGNED" && next && (
                <button onClick={() => advance(trip.id)}>
                  {next.phase === "pickup" ? "Mark arrived & guest boarded" : "Mark arrived & guest dropped"}
                </button>
              )}
            </div>
          </div>
          <div className="card">
            <h3>Route</h3>
            <MapView
              center={[trip.pickupLat, trip.pickupLng]}
              markers={[
                { id: "pickup", lat: trip.pickupLat, lng: trip.pickupLng, label: trip.pickupLabel, variant: "place" },
                { id: "drop", lat: trip.dropLat, lng: trip.dropLng, label: trip.dropLabel, variant: "place" },
                ...(me ? [{ id: "me", lat: me.currentLat, lng: me.currentLng, label: "You", variant: "driver" as const }] : []),
              ]}
            />
          </div>
        </div>
      )}
    </div>
  );
}
