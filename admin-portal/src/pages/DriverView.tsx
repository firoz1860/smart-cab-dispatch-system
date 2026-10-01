import { useEffect, useState, useCallback, useRef } from "react";
import { api, ApiError } from "../api/client";
import { getSocket } from "../api/socket";
import { useAuth } from "../auth/AuthContext";
import { MapView } from "../components/MapView";
import { formatDuration, formatCents } from "../lib/format";
import { useLiveCountdown } from "../lib/useLiveCountdown";
import { requestNotificationPermission, notify } from "../lib/pushNotify";
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
    requestNotificationPermission();
    const interval = setInterval(refresh, 5000);
    if (session) {
      const socket = getSocket();
      socket.on("trip:assigned", () => {
        notify("New trip assigned", "Open the app to review pickup details.");
        refresh();
      });
      return () => {
        clearInterval(interval);
        socket.off("trip:assigned");
      };
    }
    return () => clearInterval(interval);
  }, [refresh, session]);

  const trip = tripData?.trip;
  const next = tripData?.nextStop;
  const liveEta = useLiveCountdown(trip?.etaSeconds ?? null);

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

  // Location is shared continuously for the entire duration of a trip,
  // automatically - not left to the driver to remember to toggle on, and not
  // stoppable mid-trip.
  useEffect(() => {
    if (trip && watchIdRef.current === null) {
      startSharing();
    } else if (!trip && watchIdRef.current !== null) {
      stopSharing();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.id]);

  async function goOnline() {
    await api.post("/driver/status", { status: "AVAILABLE" });
    refresh();
  }
  async function goOffline() {
    await api.post("/driver/status", { status: "OFFLINE" });
    refresh();
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
  async function arrive(tripId: string) {
    try {
      await api.post(`/driver/trip/${tripId}/arrive`);
      refresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }
  async function advance(tripId: string) {
    try {
      await api.post(`/driver/trip/${tripId}/advance`);
      refresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }

  const guestNames = trip?.guests.map((g) => g.guest?.name).filter(Boolean).join(", ");
  const shiftDotClass =
    me?.status === "AVAILABLE"
      ? "go"
      : me?.status === "ON_BREAK"
        ? "rest"
        : !me || me.status === "OFFLINE"
          ? ""
          : "busy";
  const stops = tripData?.stops ?? [];
  const currentStopIdx = stops.findIndex((s) => !s.done);

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
          <span className="user-avatar">{session?.name?.[0]?.toUpperCase() ?? "D"}</span>
          <span className="user-name">{session?.name}</span>
          <button className="logout-btn" onClick={logout}>Log out</button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="driver-hero">
          <div className="hero-meta">
            <div className="shift-status">
              <span className={`status-dot ${shiftDotClass}`} />
              {me?.status ? me.status.replace(/_/g, " ") : "—"}
            </div>
            <p className="muted">Shift status</p>
          </div>
          <div className="hero-meta">
            <div className="earn-figure">{formatCents(me?.totalEarningsCents ?? 0)}</div>
            <p className="muted">Total earnings</p>
          </div>
          <div className="button-row">
            {me?.status === "OFFLINE" ? (
              <button onClick={goOnline}>Go online</button>
            ) : (
              <button className="danger" onClick={goOffline} disabled={!!trip}>
                Go offline
              </button>
            )}
            {sharing && <span className="live-pill">Sharing location</span>}
          </div>
        </div>
        {me?.status === "ON_BREAK" && (
          <p className="muted">On mandatory rest break until {me.freeAt ? new Date(me.freeAt).toLocaleTimeString() : "—"}.</p>
        )}
      </div>

      {!trip && (
        <div className="card">
          <div className="empty-state">
            <span className="empty-emoji" aria-hidden="true">🛰️</span>
            <p className="muted">No trip assigned right now. You'll be notified the moment the dispatch engine matches you with a guest.</p>
          </div>
        </div>
      )}

      {trip && (
        <div className="grid-2">
          <div className="card">
            <h3>Current trip — {trip.status.replace(/_/g, " ")}</h3>
            <p><strong>{trip.totalSeats}</strong> guest seat(s), <strong>{trip.totalLuggage}</strong> bag(s)</p>
            {guestNames && <p className="muted">Guest(s): {guestNames}</p>}
            <p className="muted">Destination: {trip.dropLabel}</p>
            {liveEta != null && <p><strong>ETA:</strong> ~{formatDuration(liveEta)}</p>}
            {next && (
              <div className="next-stop">
                <span className="next-chip" style={{ background: next.phase === "pickup" ? "#8a5a12" : "#2457d6" }}>
                  {next.phase === "pickup" ? "Next · Pick up" : "Next · Drop off"}
                </span>
                <p>{next.label}</p>
              </div>
            )}
            <h4>All stops</h4>
            <ul className="timeline">
              {stops.map((s, i) => (
                <li key={i} className={s.done ? "done" : i === currentStopIdx ? "current" : ""}>
                  <span className="step-sub">{s.phase === "pickup" ? "Pick up" : "Drop off"}</span>
                  {s.label}
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
              {trip.status === "EN_ROUTE_PICKUP" && (
                <button className="action-primary" onClick={() => arrive(trip.id)}>Mark arrived at pickup</button>
              )}
              {trip.status === "ARRIVED_PICKUP" && (
                <button className="action-primary" onClick={() => advance(trip.id)}>Confirm guest boarded</button>
              )}
              {trip.status === "IN_PROGRESS" && (
                <button className="action-primary" onClick={() => arrive(trip.id)}>Mark arrived at drop-off</button>
              )}
              {trip.status === "ARRIVED_DROP" && (
                <button className="action-primary" onClick={() => advance(trip.id)}>Confirm guest dropped</button>
              )}
            </div>
          </div>
          <div className="card">
            <h3>Route</h3>
            <div className="map-frame">
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
        </div>
      )}
    </div>
  );
}
