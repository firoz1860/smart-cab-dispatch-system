import { useEffect, useState, useCallback } from "react";
import { api, ApiError } from "../api/client";
import { getSocket } from "../api/socket";
import { useAuth } from "../auth/AuthContext";
import { MapView, type MapMarker } from "../components/MapView";
import type { Driver, Guest, Place, Trip, Event } from "../types";

type Tab = "overview" | "drivers" | "guests" | "requests" | "trips";

const VENUE_CENTER: [number, number] = [12.9698, 77.75];

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    AVAILABLE: "#1a9e5c",
    OFFLINE: "#888",
    ASSIGNED: "#c9820a",
    EN_ROUTE_PICKUP: "#c9820a",
    ON_TRIP: "#2563eb",
    ON_BREAK: "#7c3aed",
    QUEUED: "#c9820a",
    PENDING_APPROVAL: "#b91c1c",
    UNASSIGNABLE: "#b91c1c",
    COMPLETED: "#1a9e5c",
    CANCELLED: "#888",
  };
  return (
    <span className="badge" style={{ background: colorMap[status] ?? "#555" }}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function AdminDashboard() {
  const { session, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [event, setEvent] = useState<Event | null>(null);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [requests, setRequests] = useState<Trip[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const overview = await api.get<{ drivers: Driver[]; trips: Trip[]; event: Event }>("/admin/overview");
      setDrivers(overview.drivers);
      setTrips(overview.trips);
      setEvent(overview.event);
      const [g, p, r] = await Promise.all([
        api.get<Guest[]>("/admin/guests"),
        api.get<Place[]>("/admin/places"),
        api.get<Trip[]>("/admin/requests"),
      ]);
      setGuests(g);
      setPlaces(p);
      setRequests(r);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 6000);
    if (session) {
      const socket = getSocket(session.token);
      const onChange = () => refresh();
      socket.on("trip:assigned", onChange);
      socket.on("trip:accepted", onChange);
      socket.on("trip:rejected", onChange);
      socket.on("trip:completed", onChange);
      socket.on("trip:detour-merged", onChange);
      socket.on("trip:unassignable", onChange);
      socket.on("trip:admin-override", onChange);
      return () => {
        clearInterval(interval);
        socket.off("trip:assigned", onChange);
        socket.off("trip:accepted", onChange);
        socket.off("trip:rejected", onChange);
        socket.off("trip:completed", onChange);
        socket.off("trip:detour-merged", onChange);
        socket.off("trip:unassignable", onChange);
        socket.off("trip:admin-override", onChange);
      };
    }
    return () => clearInterval(interval);
  }, [refresh, session]);

  const driverMarkers: MapMarker[] = drivers
    .filter((d) => d.status !== "OFFLINE")
    .map((d) => ({ id: d.id, lat: d.currentLat, lng: d.currentLng, label: `${d.name} (${d.vehicleNumber}) - ${d.status}`, variant: "driver" }));
  const placeMarkers: MapMarker[] = places.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, label: `${p.name} (${p.type})`, variant: "place" }));

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <strong>Smart Cab Dispatch</strong> — Admin/Operations
        </div>
        <div>
          {session?.name} <button className="link-btn" onClick={logout}>Log out</button>
        </div>
      </header>

      <nav className="tabbar">
        {(["overview", "drivers", "guests", "requests", "trips"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
            {t === "requests" && requests.length > 0 ? `Requests (${requests.length})` : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
        <button className="tab" style={{ marginLeft: "auto" }} onClick={() => api.post("/admin/dispatch/tick")}>
          Run dispatch tick now
        </button>
      </nav>

      {error && <div className="error-banner">{error}</div>}

      {tab === "overview" && (
        <div className="grid-2">
          <div className="card">
            <h3>Live map — {event?.name}</h3>
            <MapView markers={[...driverMarkers, ...placeMarkers]} center={VENUE_CENTER} />
          </div>
          <div className="card">
            <h3>Fleet summary</h3>
            <SummaryTable drivers={drivers} trips={trips} />
          </div>
        </div>
      )}

      {tab === "drivers" && <DriversPanel drivers={drivers} onChanged={refresh} />}
      {tab === "guests" && <GuestsPanel guests={guests} places={places} onChanged={refresh} />}
      {tab === "requests" && <RequestsPanel requests={requests} onChanged={refresh} />}
      {tab === "trips" && <TripsPanel trips={trips} drivers={drivers} onChanged={refresh} />}
    </div>
  );
}

function SummaryTable({ drivers, trips }: { drivers: Driver[]; trips: Trip[] }) {
  const byStatus = (list: { status: string }[]) =>
    list.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.status]: (acc[x.status] ?? 0) + 1 }), {});
  const driverCounts = byStatus(drivers);
  const tripCounts = byStatus(trips);
  return (
    <div>
      <h4>Drivers ({drivers.length})</h4>
      <div className="chip-row">
        {Object.entries(driverCounts).map(([status, count]) => (
          <span key={status} className="chip">
            <StatusBadge status={status} /> {count}
          </span>
        ))}
      </div>
      <h4>Trips ({trips.length})</h4>
      <div className="chip-row">
        {Object.entries(tripCounts).map(([status, count]) => (
          <span key={status} className="chip">
            <StatusBadge status={status} /> {count}
          </span>
        ))}
      </div>
    </div>
  );
}

function DriversPanel({ drivers, onChanged }: { drivers: Driver[]; onChanged: () => void }) {
  const [form, setForm] = useState({
    name: "",
    phone: "",
    pin: "1234",
    vehicleNumber: "",
    seatCapacity: 4,
    luggageCapacity: 2,
    currentLat: 12.9698,
    currentLng: 77.75,
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await api.post("/admin/drivers", form);
      setForm({ ...form, name: "", phone: "", vehicleNumber: "" });
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid-2">
      <div className="card">
        <h3>Onboard a driver</h3>
        <form onSubmit={submit} className="stacked-form">
          <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Phone<input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
          <label>PIN<input required value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} /></label>
          <label>Vehicle number<input required value={form.vehicleNumber} onChange={(e) => setForm({ ...form, vehicleNumber: e.target.value })} /></label>
          <label>Seat capacity<input type="number" required value={form.seatCapacity} onChange={(e) => setForm({ ...form, seatCapacity: Number(e.target.value) })} /></label>
          <label>Luggage capacity<input type="number" required value={form.luggageCapacity} onChange={(e) => setForm({ ...form, luggageCapacity: Number(e.target.value) })} /></label>
          {formError && <div className="error-banner">{formError}</div>}
          <button type="submit" disabled={submitting}>Add driver</button>
        </form>
      </div>
      <div className="card">
        <h3>All drivers</h3>
        <table className="data-table">
          <thead><tr><th>Name</th><th>Vehicle</th><th>Cap.</th><th>Status</th></tr></thead>
          <tbody>
            {drivers.map((d) => (
              <tr key={d.id}>
                <td>{d.name}<div className="muted">{d.phone}</div></td>
                <td>{d.vehicleNumber}</td>
                <td>{d.seatCapacity}s / {d.luggageCapacity}l</td>
                <td><StatusBadge status={d.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GuestsPanel({ guests, places, onChanged }: { guests: Guest[]; places: Place[]; onChanged: () => void }) {
  const [form, setForm] = useState({ name: "", phone: "", pin: "1234", partySize: 1, luggageCount: 1, accommodationId: "" });
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      await api.post("/admin/guests", { ...form, accommodationId: form.accommodationId || undefined });
      setForm({ ...form, name: "", phone: "" });
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) setFormError(err.message);
    }
  }

  return (
    <div className="grid-2">
      <div className="card">
        <h3>Register a guest</h3>
        <form onSubmit={submit} className="stacked-form">
          <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Phone<input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
          <label>PIN<input required value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} /></label>
          <label>Party size<input type="number" required value={form.partySize} onChange={(e) => setForm({ ...form, partySize: Number(e.target.value) })} /></label>
          <label>Luggage count<input type="number" required value={form.luggageCount} onChange={(e) => setForm({ ...form, luggageCount: Number(e.target.value) })} /></label>
          <label>
            Accommodation
            <select value={form.accommodationId} onChange={(e) => setForm({ ...form, accommodationId: e.target.value })}>
              <option value="">— none yet —</option>
              {places.filter((p) => p.type === "ACCOMMODATION").map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          {formError && <div className="error-banner">{formError}</div>}
          <button type="submit">Register guest</button>
        </form>
      </div>
      <div className="card">
        <h3>All guests ({guests.length})</h3>
        <table className="data-table">
          <thead><tr><th>Name</th><th>Party</th><th>Accommodation</th></tr></thead>
          <tbody>
            {guests.map((g) => (
              <tr key={g.id}>
                <td>{g.name}<div className="muted">{g.phone}</div></td>
                <td>{g.partySize} pax / {g.luggageCount} bags</td>
                <td>{g.accommodation?.name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RequestsPanel({ requests, onChanged }: { requests: Trip[]; onChanged: () => void }) {
  async function approve(id: string) {
    await api.post(`/admin/requests/${id}/approve`);
    onChanged();
  }
  async function decline(id: string) {
    const reason = window.prompt("Reason for declining (optional)") ?? undefined;
    await api.post(`/admin/requests/${id}/decline`, { reason });
    onChanged();
  }
  return (
    <div className="card">
      <h3>On-demand ride requests awaiting approval</h3>
      {requests.length === 0 && <p className="muted">No pending requests.</p>}
      <table className="data-table">
        <thead><tr><th>Guest</th><th>Pickup</th><th>Drop</th><th>Requested</th><th></th></tr></thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td>{r.guests.map((g) => g.guest?.name).join(", ")}</td>
              <td>{r.pickupLabel}</td>
              <td>{r.dropLabel}</td>
              <td>{new Date(r.requestedAt).toLocaleTimeString()}</td>
              <td>
                <button onClick={() => approve(r.id)}>Approve</button>{" "}
                <button className="danger" onClick={() => decline(r.id)}>Decline</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TripsPanel({ trips, drivers, onChanged }: { trips: Trip[]; drivers: Driver[]; onChanged: () => void }) {
  async function override(tripId: string) {
    const driverId = window.prompt(
      `Force-assign which driver id?\n\n${drivers.map((d) => `${d.id}: ${d.name} (${d.status})`).join("\n")}`
    );
    if (!driverId) return;
    try {
      await api.post(`/admin/trips/${tripId}/override`, { driverId, note: "Manual admin override" });
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) alert(err.message);
    }
  }

  return (
    <div className="card">
      <h3>All active trips ({trips.length})</h3>
      <table className="data-table">
        <thead><tr><th>Type</th><th>Pickup → Drop</th><th>Seats</th><th>Status</th><th>Driver</th><th>ETA</th><th></th></tr></thead>
        <tbody>
          {trips.map((t) => (
            <tr key={t.id} className={t.status === "UNASSIGNABLE" ? "row-alert" : ""}>
              <td>{t.type}</td>
              <td>{t.pickupLabel} → {t.dropLabel}</td>
              <td>{t.totalSeats}s/{t.totalLuggage}l</td>
              <td><StatusBadge status={t.status} /></td>
              <td>{t.driver?.name ?? "—"}</td>
              <td>{t.etaSeconds ? `${Math.round(t.etaSeconds / 60)} min` : "—"}</td>
              <td>
                {(t.status === "QUEUED" || t.status === "UNASSIGNABLE") && (
                  <button onClick={() => override(t.id)}>Override assign</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
