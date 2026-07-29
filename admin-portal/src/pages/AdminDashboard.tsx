import { useEffect, useState, useCallback, Fragment } from "react";
import { api, ApiError } from "../api/client";
import { getSocket } from "../api/socket";
import { useAuth } from "../auth/AuthContext";
import { MapView, type MapMarker } from "../components/MapView";
import { formatDuration } from "../lib/format";
import { useLiveCountdown } from "../lib/useLiveCountdown";
import type { Driver, Guest, Place, Trip, Event } from "../types";

type Tab = "overview" | "drivers" | "guests" | "requests" | "trips";

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
      const onDriverLocation = (data: { driverId: string; lat: number; lng: number; tripId: string | null; etaSeconds: number | null }) => {
        setDrivers((prev) =>
          prev.map((d) => (d.id === data.driverId ? { ...d, currentLat: data.lat, currentLng: data.lng } : d))
        );
        if (data.tripId) {
          setTrips((prev) =>
            prev.map((t) => (t.id === data.tripId ? { ...t, etaSeconds: data.etaSeconds ?? t.etaSeconds } : t))
          );
        }
      };
      socket.on("driver:location", onDriverLocation);
      return () => {
        clearInterval(interval);
        socket.off("trip:assigned", onChange);
        socket.off("trip:accepted", onChange);
        socket.off("trip:rejected", onChange);
        socket.off("trip:completed", onChange);
        socket.off("trip:detour-merged", onChange);
        socket.off("trip:unassignable", onChange);
        socket.off("trip:admin-override", onChange);
        socket.off("driver:location", onDriverLocation);
      };
    }
    return () => clearInterval(interval);
  }, [refresh, session]);

  const driverMarkers: MapMarker[] = drivers
    .filter((d) => d.status !== "OFFLINE")
    .map((d) => ({ id: d.id, lat: d.currentLat, lng: d.currentLng, label: `${d.name} (${d.vehicleNumber}) - ${d.status}`, variant: "driver" }));
  const placeMarkers: MapMarker[] = places.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, label: `${p.name} (${p.type})`, variant: "place" }));

  const venue = places.find((p) => p.type === "VENUE");
  const venueCenter: [number, number] = venue
    ? [venue.lat, venue.lng]
    : places[0]
    ? [places[0].lat, places[0].lng]
    : drivers[0]
    ? [drivers[0].currentLat, drivers[0].currentLng]
    : [0, 0];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🚕</span>
          <div className="brand-text">
            <span className="brand-title">Smart Cab Dispatch</span>
            <span className="brand-subtitle">Admin / Operations</span>
          </div>
        </div>
        <div className="user-chip">
          <span className="user-name">{session?.name}</span>
          <button className="logout-btn" onClick={logout}>Log out</button>
        </div>
      </header>

      <nav className="tabbar">
        {(["overview", "drivers", "guests", "requests", "trips"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
            {t === "requests" && requests.length > 0 ? `Requests (${requests.length})` : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
        <div className="tabbar-spacer">
          <button className="tab" onClick={() => api.post("/admin/dispatch/tick")}>
            Run dispatch tick now
          </button>
        </div>
      </nav>

      {error && <div className="error-banner">{error}</div>}

      {tab === "overview" && (
        <div className="grid-2">
          <div className="card">
            <h3>Live map — {event?.name}</h3>
            <MapView markers={[...driverMarkers, ...placeMarkers]} center={venueCenter} />
          </div>
          <div className="card">
            <h3>Fleet summary</h3>
            <SummaryTable drivers={drivers} trips={trips} />
          </div>
        </div>
      )}

      {tab === "drivers" && <DriversPanel drivers={drivers} defaultLat={venueCenter[0]} defaultLng={venueCenter[1]} onChanged={refresh} />}
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

const DRIVERS_PAGE_SIZE = 10;

function DriversPanel({
  drivers,
  defaultLat,
  defaultLng,
  onChanged,
}: {
  drivers: Driver[];
  defaultLat: number;
  defaultLng: number;
  onChanged: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    phone: "",
    pin: "1234",
    vehicleNumber: "",
    seatCapacity: 4,
    luggageCapacity: 2,
    currentLat: defaultLat,
    currentLng: defaultLng,
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", phone: "", vehicleNumber: "", seatCapacity: 4, luggageCapacity: 2 });
  const [editError, setEditError] = useState<string | null>(null);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

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

  function startEdit(d: Driver) {
    setEditingId(d.id);
    setEditForm({
      name: d.name,
      phone: d.phone,
      vehicleNumber: d.vehicleNumber,
      seatCapacity: d.seatCapacity,
      luggageCapacity: d.luggageCapacity,
    });
    setEditError(null);
  }

  async function saveEdit(id: string) {
    setRowBusyId(id);
    setEditError(null);
    try {
      await api.patch(`/admin/drivers/${id}`, editForm);
      setEditingId(null);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) setEditError(err.message);
    } finally {
      setRowBusyId(null);
    }
  }

  async function deleteDriver(d: Driver) {
    if (!window.confirm(`Remove ${d.name} (${d.vehicleNumber})? This can't be undone.`)) return;
    setRowBusyId(d.id);
    try {
      await api.delete(`/admin/drivers/${d.id}`);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) alert(err.message);
    } finally {
      setRowBusyId(null);
    }
  }

  function updateQuery(value: string) {
    setQuery(value);
    setPage(1);
  }

  const q = query.trim().toLowerCase();
  const filteredDrivers = q
    ? drivers.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          d.phone.toLowerCase().includes(q) ||
          d.vehicleNumber.toLowerCase().includes(q)
      )
    : drivers;
  const totalPages = Math.max(1, Math.ceil(filteredDrivers.length / DRIVERS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageDrivers = filteredDrivers.slice(
    (currentPage - 1) * DRIVERS_PAGE_SIZE,
    currentPage * DRIVERS_PAGE_SIZE
  );

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
          <label>Starting latitude<input type="number" step="any" required value={form.currentLat} onChange={(e) => setForm({ ...form, currentLat: Number(e.target.value) })} /></label>
          <label>Starting longitude<input type="number" step="any" required value={form.currentLng} onChange={(e) => setForm({ ...form, currentLng: Number(e.target.value) })} /></label>
          {formError && <div className="error-banner">{formError}</div>}
          <button type="submit" disabled={submitting}>Add driver</button>
        </form>
      </div>
      <div className="card">
        <h3>All drivers ({filteredDrivers.length}{q ? ` of ${drivers.length}` : ""})</h3>
        <input
          className="search-input"
          placeholder="Search by name, phone, or vehicle number..."
          value={query}
          onChange={(e) => updateQuery(e.target.value)}
        />
        {filteredDrivers.length > 0 && (
          <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Vehicle</th><th>Cap.</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {pageDrivers.map((d) => (
                <Fragment key={d.id}>
                  <tr>
                    <td>{d.name}<div className="muted">{d.phone}</div></td>
                    <td>{d.vehicleNumber}</td>
                    <td>{d.seatCapacity}s / {d.luggageCapacity}l</td>
                    <td><StatusBadge status={d.status} /></td>
                    <td>
                      {editingId === d.id ? (
                        <button className="secondary" onClick={() => setEditingId(null)}>Cancel</button>
                      ) : (
                        <div className="button-row">
                          <button onClick={() => startEdit(d)}>Edit</button>
                          <button className="danger" disabled={rowBusyId === d.id} onClick={() => deleteDriver(d)}>
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  {editingId === d.id && (
                    <tr>
                      <td colSpan={5}>
                        <div className="stacked-form">
                          <label>Name<input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></label>
                          <label>Phone<input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} /></label>
                          <label>Vehicle number<input value={editForm.vehicleNumber} onChange={(e) => setEditForm({ ...editForm, vehicleNumber: e.target.value })} /></label>
                          <label>Seat capacity<input type="number" value={editForm.seatCapacity} onChange={(e) => setEditForm({ ...editForm, seatCapacity: Number(e.target.value) })} /></label>
                          <label>Luggage capacity<input type="number" value={editForm.luggageCapacity} onChange={(e) => setEditForm({ ...editForm, luggageCapacity: Number(e.target.value) })} /></label>
                          {editError && <div className="error-banner">{editError}</div>}
                          <button onClick={() => saveEdit(d.id)} disabled={rowBusyId === d.id}>Save changes</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {filteredDrivers.length === 0 && <p className="muted">No drivers match "{query}".</p>}
        {filteredDrivers.length > DRIVERS_PAGE_SIZE && (
          <div className="pagination">
            <button
              className="secondary"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              Prev
            </button>
            <span className="muted">Page {currentPage} of {totalPages}</span>
            <button
              className="secondary"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const GUESTS_PAGE_SIZE = 10;

function GuestsPanel({ guests, places, onChanged }: { guests: Guest[]; places: Place[]; onChanged: () => void }) {
  const [form, setForm] = useState({ name: "", phone: "", pin: "1234", partySize: 1, luggageCount: 1, accommodationId: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

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

  function updateQuery(value: string) {
    setQuery(value);
    setPage(1);
  }

  const q = query.trim().toLowerCase();
  const filteredGuests = q
    ? guests.filter((g) => g.name.toLowerCase().includes(q) || g.phone.toLowerCase().includes(q))
    : guests;
  const totalPages = Math.max(1, Math.ceil(filteredGuests.length / GUESTS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageGuests = filteredGuests.slice(
    (currentPage - 1) * GUESTS_PAGE_SIZE,
    currentPage * GUESTS_PAGE_SIZE
  );

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
        <h3>All guests ({filteredGuests.length}{q ? ` of ${guests.length}` : ""})</h3>
        <input
          className="search-input"
          placeholder="Search by name or phone..."
          value={query}
          onChange={(e) => updateQuery(e.target.value)}
        />
        {filteredGuests.length > 0 && (
          <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Party</th><th>Accommodation</th></tr></thead>
            <tbody>
              {pageGuests.map((g) => (
                <tr key={g.id}>
                  <td>{g.name}<div className="muted">{g.phone}</div></td>
                  <td>{g.partySize} pax / {g.luggageCount} bags</td>
                  <td>{g.accommodation?.name ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {filteredGuests.length === 0 && <p className="muted">No guests match "{query}".</p>}
        {filteredGuests.length > GUESTS_PAGE_SIZE && (
          <div className="pagination">
            <button
              className="secondary"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              Prev
            </button>
            <span className="muted">Page {currentPage} of {totalPages}</span>
            <button
              className="secondary"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function RequestsPanel({ requests, onChanged }: { requests: Trip[]; onChanged: () => void }) {
  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function approve(id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await api.post(`/admin/requests/${id}/approve`);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) setActionError(err.message);
    } finally {
      setBusyId(null);
    }
  }
  async function decline(id: string) {
    const reason = window.prompt("Reason for declining (optional)") ?? undefined;
    setBusyId(id);
    setActionError(null);
    try {
      await api.post(`/admin/requests/${id}/decline`, { reason });
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) setActionError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? requests.filter((r) =>
        r.guests.some(
          (g) => g.guest?.name.toLowerCase().includes(q) || g.guest?.phone.toLowerCase().includes(q)
        )
      )
    : requests;

  return (
    <div className="card">
      <h3>On-demand ride requests awaiting approval</h3>
      <input
        className="search-input"
        placeholder="Search by guest name or phone..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {actionError && <div className="error-banner">{actionError}</div>}
      {requests.length === 0 && <p className="muted">No pending requests.</p>}
      {requests.length > 0 && filtered.length === 0 && <p className="muted">No requests match "{query}".</p>}
      <div className="table-scroll">
      <table className="data-table">
        <thead><tr><th>Guest</th><th>Pickup</th><th>Drop</th><th>Requested</th><th></th></tr></thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={r.id}>
              <td>{r.guests.map((g) => g.guest?.name).join(", ")}</td>
              <td>{r.pickupLabel}</td>
              <td>{r.dropLabel}</td>
              <td>{new Date(r.requestedAt).toLocaleTimeString()}</td>
              <td>
                <div className="button-row">
                  <button disabled={busyId === r.id} onClick={() => approve(r.id)}>Approve</button>
                  <button className="danger" disabled={busyId === r.id} onClick={() => decline(r.id)}>Decline</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function TripEtaCell({ etaSeconds }: { etaSeconds: number | null }) {
  const liveEta = useLiveCountdown(etaSeconds);
  return <td>{liveEta != null ? formatDuration(liveEta) : "—"}</td>;
}

function TripsPanel({ trips, drivers, onChanged }: { trips: Trip[]; drivers: Driver[]; onChanged: () => void }) {
  const [overridingTripId, setOverridingTripId] = useState<string | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState("");
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");

  function startOverride(tripId: string) {
    setOverridingTripId(tripId);
    setSelectedDriverId("");
    setOverrideError(null);
  }

  function cancelOverride() {
    setOverridingTripId(null);
    setOverrideError(null);
  }

  async function confirmOverride() {
    if (!overridingTripId || !selectedDriverId) return;
    setSubmitting(true);
    setOverrideError(null);
    try {
      await api.post(`/admin/trips/${overridingTripId}/override`, {
        driverId: selectedDriverId,
        note: "Manual admin override",
      });
      setOverridingTripId(null);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) setOverrideError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const q = query.trim().toLowerCase();
  const filteredTrips = q
    ? trips.filter(
        (t) =>
          t.driver?.name.toLowerCase().includes(q) ||
          t.driver?.vehicleNumber.toLowerCase().includes(q) ||
          t.guests.some(
            (g) => g.guest?.name.toLowerCase().includes(q) || g.guest?.phone.toLowerCase().includes(q)
          )
      )
    : trips;

  return (
    <div className="card">
      <h3>All active trips ({trips.length})</h3>
      <input
        className="search-input"
        placeholder="Search by driver name, vehicle number, or guest name/phone..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {trips.length > 0 && filteredTrips.length === 0 && <p className="muted">No trips match "{query}".</p>}
      <div className="table-scroll">
      <table className="data-table">
        <thead><tr><th>Type</th><th>Pickup → Drop</th><th>Seats</th><th>Status</th><th>Driver</th><th>ETA</th><th></th></tr></thead>
        <tbody>
          {filteredTrips.map((t) => (
            <Fragment key={t.id}>
              <tr className={t.status === "UNASSIGNABLE" ? "row-alert" : ""}>
                <td>{t.type}</td>
                <td>{t.pickupLabel} → {t.dropLabel}</td>
                <td>{t.totalSeats}s/{t.totalLuggage}l</td>
                <td><StatusBadge status={t.status} /></td>
                <td>{t.driver?.name ?? "—"}</td>
                <TripEtaCell etaSeconds={t.etaSeconds} />
                <td>
                  {(t.status === "QUEUED" || t.status === "UNASSIGNABLE") && (
                    overridingTripId === t.id ? (
                      <button className="secondary" onClick={cancelOverride}>Cancel</button>
                    ) : (
                      <button onClick={() => startOverride(t.id)}>Override assign</button>
                    )
                  )}
                </td>
              </tr>
              {overridingTripId === t.id && (
                <tr>
                  <td colSpan={7}>
                    <div className="button-row">
                      <label>
                        Assign driver
                        <select value={selectedDriverId} onChange={(e) => setSelectedDriverId(e.target.value)}>
                          <option value="">— choose a driver by name —</option>
                          {drivers.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name} · {d.vehicleNumber} · {d.phone} · {d.seatCapacity}s/{d.luggageCapacity}l · {d.status}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button onClick={confirmOverride} disabled={!selectedDriverId || submitting}>
                        Confirm assignment
                      </button>
                    </div>
                    {overrideError && <div className="error-banner">{overrideError}</div>}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
