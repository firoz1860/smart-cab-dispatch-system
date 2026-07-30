import { useEffect, useState, useCallback, useRef, Fragment } from "react";
import { api, ApiError } from "../api/client";
import { getSocket } from "../api/socket";
import { useAuth } from "../auth/AuthContext";
import { MapView, type MapMarker } from "../components/MapView";
import { useToast } from "../components/Toast";
import { formatDuration, formatCents } from "../lib/format";
import { useLiveCountdown } from "../lib/useLiveCountdown";
import type { Driver, Guest, Place, Trip, Event } from "../types";

type Tab = "overview" | "drivers" | "guests" | "requests" | "trips" | "payments";

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    AVAILABLE: "#1a9e5c",
    OFFLINE: "#888",
    ASSIGNED: "#c9820a",
    EN_ROUTE_PICKUP: "#c9820a",
    ARRIVED_PICKUP: "#2563eb",
    ARRIVED_DROP: "#2563eb",
    ON_TRIP: "#2563eb",
    ON_BREAK: "#7c3aed",
    QUEUED: "#c9820a",
    PENDING_APPROVAL: "#b91c1c",
    UNASSIGNABLE: "#b91c1c",
    COMPLETED: "#1a9e5c",
    CANCELLED: "#888",
    PAID: "#1a9e5c",
    PENDING: "#c9820a",
    UNPAID: "#888",
    FAILED: "#b91c1c",
    REFUNDED: "#7c3aed",
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
      const socket = getSocket();
      const onChange = () => refresh();
      socket.on("trip:assigned", onChange);
      socket.on("trip:accepted", onChange);
      socket.on("trip:rejected", onChange);
      socket.on("trip:completed", onChange);
      socket.on("trip:detour-merged", onChange);
      socket.on("trip:unassignable", onChange);
      socket.on("trip:admin-override", onChange);
      socket.on("trip:arrived-pickup", onChange);
      socket.on("trip:arrived-drop", onChange);
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
        socket.off("trip:arrived-pickup", onChange);
        socket.off("trip:arrived-drop", onChange);
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
        {(["overview", "drivers", "guests", "requests", "trips", "payments"] as Tab[]).map((t) => (
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
      {tab === "trips" && (
        <TripsPanel trips={trips} drivers={drivers} guests={guests} places={places} onChanged={refresh} />
      )}
      {tab === "payments" && <PaymentsPanel />}
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
  const tableScrollRef = useRef<HTMLDivElement | null>(null);

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
    // On a narrow screen the table may be scrolled horizontally to reach the
    // "Edit" button in the last column - snap back to the left so the edit
    // form (which spans the full row) is actually visible without the user
    // having to manually scroll back themselves.
    tableScrollRef.current?.scrollTo({ left: 0, behavior: "smooth" });
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
    <div className="grid-form-table">
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
          <div className="table-scroll" ref={tableScrollRef}>
          <table className="data-table">
            <thead><tr><th>Name</th><th>Vehicle</th><th>Cap.</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {pageDrivers.map((d) => (
                <Fragment key={d.id}>
                  <tr>
                    <td data-label="Name">{d.name}<div className="muted">{d.phone}</div></td>
                    <td data-label="Vehicle">{d.vehicleNumber}</td>
                    <td data-label="Cap.">{d.seatCapacity}s / {d.luggageCapacity}l</td>
                    <td data-label="Status"><StatusBadge status={d.status} /></td>
                    <td data-label="">
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
    <div className="grid-form-table">
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
                  <td data-label="Name">{g.name}<div className="muted">{g.phone}</div></td>
                  <td data-label="Party">{g.partySize} pax / {g.luggageCount} bags</td>
                  <td data-label="Accommodation">{g.accommodation?.name ?? "—"}</td>
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

const REQUESTS_PAGE_SIZE = 10;

function RequestsPanel({ requests, onChanged }: { requests: Trip[]; onChanged: () => void }) {
  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

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

  function updateQuery(value: string) {
    setQuery(value);
    setPage(1);
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? requests.filter((r) =>
        r.guests.some(
          (g) => g.guest?.name.toLowerCase().includes(q) || g.guest?.phone.toLowerCase().includes(q)
        )
      )
    : requests;
  const totalPages = Math.max(1, Math.ceil(filtered.length / REQUESTS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRequests = filtered.slice((currentPage - 1) * REQUESTS_PAGE_SIZE, currentPage * REQUESTS_PAGE_SIZE);

  return (
    <div className="card">
      <h3>On-demand ride requests awaiting approval ({filtered.length}{q ? ` of ${requests.length}` : ""})</h3>
      <input
        className="search-input"
        placeholder="Search by guest name or phone..."
        value={query}
        onChange={(e) => updateQuery(e.target.value)}
      />
      {actionError && <div className="error-banner">{actionError}</div>}
      {requests.length === 0 && <p className="muted">No pending requests.</p>}
      {requests.length > 0 && filtered.length === 0 && <p className="muted">No requests match "{query}".</p>}
      {pageRequests.length > 0 && (
        <div className="table-scroll">
        <table className="data-table">
          <thead><tr><th>Guest</th><th>Pickup</th><th>Drop</th><th>Requested</th><th></th></tr></thead>
          <tbody>
            {pageRequests.map((r) => (
              <tr key={r.id}>
                <td data-label="Guest">{r.guests.map((g) => g.guest?.name).join(", ")}</td>
                <td data-label="Pickup">{r.pickupLabel}</td>
                <td data-label="Drop">{r.dropLabel}</td>
                <td data-label="Requested">{new Date(r.requestedAt).toLocaleTimeString()}</td>
                <td data-label="">
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
      )}
      {filtered.length > REQUESTS_PAGE_SIZE && (
        <div className="pagination">
          <button className="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>
            Prev
          </button>
          <span className="muted">Page {currentPage} of {totalPages}</span>
          <button className="secondary" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function TripEtaCell({ etaSeconds }: { etaSeconds: number | null }) {
  const liveEta = useLiveCountdown(etaSeconds);
  return <td data-label="ETA">{liveEta != null ? formatDuration(liveEta) : "—"}</td>;
}

const TRIPS_PAGE_SIZE = 10;

const TRIP_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "ARRIVAL", label: "Arrival — airport/station → accommodation" },
  { value: "TO_VENUE", label: "To venue — accommodation → venue" },
  { value: "RETURN", label: "Return — venue → accommodation" },
  { value: "DEPARTURE", label: "Departure — accommodation → airport/station" },
];

function TripsPanel({
  trips,
  drivers,
  guests,
  places,
  onChanged,
}: {
  trips: Trip[];
  drivers: Driver[];
  guests: Guest[];
  places: Place[];
  onChanged: () => void;
}) {
  const { showToast } = useToast();
  const [overridingTripId, setOverridingTripId] = useState<string | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);

  const [scheduleForm, setScheduleForm] = useState({
    guestId: "",
    type: "ARRIVAL",
    pickupPlaceId: "",
    dropPlaceId: "",
    scheduledTime: "",
    deadline: "",
  });
  const [scheduling, setScheduling] = useState(false);

  function startOverride(tripId: string) {
    setOverridingTripId(tripId);
    setSelectedDriverId("");
    tableScrollRef.current?.scrollTo({ left: 0, behavior: "smooth" });
  }

  function cancelOverride() {
    setOverridingTripId(null);
  }

  async function confirmOverride() {
    if (!overridingTripId || !selectedDriverId) return;
    setSubmitting(true);
    try {
      await api.post(`/admin/trips/${overridingTripId}/override`, {
        driverId: selectedDriverId,
        note: "Manual admin override",
      });
      setOverridingTripId(null);
      showToast("Driver assigned successfully.", "success");
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) showToast(err.message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function scheduleTrip(e: React.FormEvent) {
    e.preventDefault();
    const pickup = places.find((p) => p.id === scheduleForm.pickupPlaceId);
    const drop = places.find((p) => p.id === scheduleForm.dropPlaceId);
    if (!scheduleForm.guestId || !pickup || !drop) {
      showToast("Choose a guest, pickup, and drop location.", "error");
      return;
    }
    setScheduling(true);
    try {
      await api.post("/admin/trips", {
        guestId: scheduleForm.guestId,
        type: scheduleForm.type,
        pickupLabel: pickup.name,
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        dropLabel: drop.name,
        dropLat: drop.lat,
        dropLng: drop.lng,
        scheduledTime: scheduleForm.scheduledTime ? new Date(scheduleForm.scheduledTime).toISOString() : undefined,
        deadline: scheduleForm.deadline ? new Date(scheduleForm.deadline).toISOString() : undefined,
      });
      showToast("Trip scheduled — the dispatch engine will assign a driver automatically.", "success");
      setScheduleForm({ ...scheduleForm, guestId: "", pickupPlaceId: "", dropPlaceId: "", scheduledTime: "", deadline: "" });
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) showToast(err.message, "error");
    } finally {
      setScheduling(false);
    }
  }

  function updateQuery(value: string) {
    setQuery(value);
    setPage(1);
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
  const totalPages = Math.max(1, Math.ceil(filteredTrips.length / TRIPS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageTrips = filteredTrips.slice((currentPage - 1) * TRIPS_PAGE_SIZE, currentPage * TRIPS_PAGE_SIZE);

  return (
    <div className="grid-form-table">
      <div className="card">
        <h3>Schedule a trip</h3>
        <form onSubmit={scheduleTrip} className="stacked-form">
          <label>
            Guest
            <select value={scheduleForm.guestId} onChange={(e) => setScheduleForm({ ...scheduleForm, guestId: e.target.value })} required>
              <option value="">— choose a guest —</option>
              {guests.map((g) => (
                <option key={g.id} value={g.id}>{g.name} · {g.phone} · {g.partySize} pax</option>
              ))}
            </select>
          </label>
          <label>
            Trip type
            <select value={scheduleForm.type} onChange={(e) => setScheduleForm({ ...scheduleForm, type: e.target.value })}>
              {TRIP_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
          <label>
            Pickup
            <select value={scheduleForm.pickupPlaceId} onChange={(e) => setScheduleForm({ ...scheduleForm, pickupPlaceId: e.target.value })} required>
              <option value="">— choose a place —</option>
              {places.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
              ))}
            </select>
          </label>
          <label>
            Drop
            <select value={scheduleForm.dropPlaceId} onChange={(e) => setScheduleForm({ ...scheduleForm, dropPlaceId: e.target.value })} required>
              <option value="">— choose a place —</option>
              {places.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
              ))}
            </select>
          </label>
          <label>
            Scheduled time (optional)
            <input
              type="datetime-local"
              value={scheduleForm.scheduledTime}
              onChange={(e) => setScheduleForm({ ...scheduleForm, scheduledTime: e.target.value })}
            />
          </label>
          <label>
            Deadline (optional)
            <input
              type="datetime-local"
              value={scheduleForm.deadline}
              onChange={(e) => setScheduleForm({ ...scheduleForm, deadline: e.target.value })}
            />
          </label>
          <button type="submit" disabled={scheduling}>Schedule trip</button>
        </form>
      </div>
      <div className="card">
      <h3>All active trips ({filteredTrips.length}{q ? ` of ${trips.length}` : ""})</h3>
      <input
        className="search-input"
        placeholder="Search by driver name, vehicle number, or guest name/phone..."
        value={query}
        onChange={(e) => updateQuery(e.target.value)}
      />
      {trips.length > 0 && filteredTrips.length === 0 && <p className="muted">No trips match "{query}".</p>}
      {pageTrips.length > 0 && (
      <div className="table-scroll" ref={tableScrollRef}>
      <table className="data-table">
        <thead><tr><th>Type</th><th>Pickup → Drop</th><th>Seats</th><th>Status</th><th>Driver</th><th>ETA</th><th></th></tr></thead>
        <tbody>
          {pageTrips.map((t) => (
            <Fragment key={t.id}>
              <tr className={t.status === "UNASSIGNABLE" ? "row-alert" : ""}>
                <td data-label="Type">{t.type}</td>
                <td data-label="Pickup → Drop">{t.pickupLabel} → {t.dropLabel}</td>
                <td data-label="Seats">{t.totalSeats}s/{t.totalLuggage}l</td>
                <td data-label="Status"><StatusBadge status={t.status} /></td>
                <td data-label="Driver">{t.driver?.name ?? "—"}</td>
                <TripEtaCell etaSeconds={t.etaSeconds} />
                <td data-label="">
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
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      </div>
      )}
      {filteredTrips.length > TRIPS_PAGE_SIZE && (
        <div className="pagination">
          <button className="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>
            Prev
          </button>
          <span className="muted">Page {currentPage} of {totalPages}</span>
          <button className="secondary" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>
            Next
          </button>
        </div>
      )}
      </div>
    </div>
  );
}

interface PaymentRow {
  id: string;
  tripId: string;
  guestName: string;
  driverName: string | null;
  pickupLabel: string;
  dropLabel: string;
  fareAmountCents: number | null;
  paymentStatus: string;
  paidAt: string | null;
}

interface DriverEarningRow {
  id: string;
  name: string;
  vehicleNumber: string;
  totalEarningsCents: number;
}

interface PaymentsResponse {
  payments: PaymentRow[];
  totalRevenueCents: number;
  totalPendingCents: number;
  driverEarnings: DriverEarningRow[];
}

const PAYMENTS_PAGE_SIZE = 10;

function PaymentsPanel() {
  const [data, setData] = useState<PaymentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<PaymentsResponse>("/admin/payments");
      setData(res);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 8000);
    return () => clearInterval(interval);
  }, [refresh]);

  function updateQuery(value: string) {
    setQuery(value);
    setPage(1);
  }

  const q = query.trim().toLowerCase();
  const payments = data?.payments ?? [];
  const filtered = q
    ? payments.filter(
        (p) =>
          p.guestName.toLowerCase().includes(q) ||
          (p.driverName ?? "").toLowerCase().includes(q)
      )
    : payments;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAYMENTS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagePayments = filtered.slice((currentPage - 1) * PAYMENTS_PAGE_SIZE, currentPage * PAYMENTS_PAGE_SIZE);

  return (
    <div className="grid-form-table">
      <div className="card">
        <h3>Revenue</h3>
        {error && <div className="error-banner">{error}</div>}
        <div className="chip-row">
          <span className="chip"><strong>Collected:</strong>&nbsp;{formatCents(data?.totalRevenueCents ?? 0)}</span>
          <span className="chip"><strong>Pending:</strong>&nbsp;{formatCents(data?.totalPendingCents ?? 0)}</span>
        </div>
        <p className="muted">
          Fares are charged to guests via Stripe when they're dropped off. Driver "earnings" below are
          an internal ledger (80% of each paid fare) - not yet a real bank transfer, since that needs
          each driver to complete Stripe Connect onboarding (a separate, larger integration).
        </p>
        <h4>Driver earnings</h4>
        <table className="data-table">
          <thead><tr><th>Driver</th><th>Vehicle</th><th>Earned</th></tr></thead>
          <tbody>
            {(data?.driverEarnings ?? []).length === 0 && (
              <tr><td colSpan={3} className="muted">No completed/paid trips yet.</td></tr>
            )}
            {(data?.driverEarnings ?? []).map((d) => (
              <tr key={d.id}>
                <td data-label="Driver">{d.name}</td>
                <td data-label="Vehicle">{d.vehicleNumber}</td>
                <td data-label="Earned">{formatCents(d.totalEarningsCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>Fares ({filtered.length}{q ? ` of ${payments.length}` : ""})</h3>
        <input
          className="search-input"
          placeholder="Search by guest or driver name..."
          value={query}
          onChange={(e) => updateQuery(e.target.value)}
        />
        {payments.length === 0 && <p className="muted">No fares recorded yet - fares are generated once a trip's guest is dropped off.</p>}
        {payments.length > 0 && filtered.length === 0 && <p className="muted">No fares match "{query}".</p>}
        {filtered.length > 0 && (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Guest</th><th>Driver</th><th>Route</th><th>Fare</th><th>Status</th></tr></thead>
              <tbody>
                {pagePayments.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Guest">{p.guestName}</td>
                    <td data-label="Driver">{p.driverName ?? "—"}</td>
                    <td data-label="Route">{p.pickupLabel} → {p.dropLabel}</td>
                    <td data-label="Fare">{p.fareAmountCents != null ? formatCents(p.fareAmountCents) : "—"}</td>
                    <td data-label="Status"><StatusBadge status={p.paymentStatus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {filtered.length > PAYMENTS_PAGE_SIZE && (
          <div className="pagination">
            <button className="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>
              Prev
            </button>
            <span className="muted">Page {currentPage} of {totalPages}</span>
            <button className="secondary" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
