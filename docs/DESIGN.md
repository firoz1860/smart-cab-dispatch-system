# Smart Cab Dispatch System — Design Document

## 1. Overview

This system automates driver-to-guest matching for a single private group event
(conference/offsite): airport/station arrivals, accommodation ↔ venue shuttles,
and departures. Three applications share one backend:

- **Guest App** (`guest-app/`) — guests view pickup details, get matched
  automatically, track their ride live, and can raise on-demand requests.
- **Admin Portal** (`admin-portal/`) — one codebase, two RBAC-gated views:
  **Admin/Operations** (full visibility, approvals, manual override) and
  **Driver** (their one active trip only).
- **Backend** (`backend/`) — Express + Socket.IO API, SQLite via Prisma, and
  the matching/dispatch engine.

## 2. Data model

`Trip` is the central unit of work: one pickup → one drop, carrying one or
more guests (`TripGuest`). A trip can represent a scheduled arrival/return/
departure (`origin: SCHEDULED`) or a guest-initiated on-demand request
(`origin: ON_DEMAND`, starts in `PENDING_APPROVAL` until Admin/Operations acts
on it — this is the one deliberately manual step in an otherwise automated
pipeline, per the assignment's stated automation boundary).

Because SQLite has no native enum type, all enum-like columns
(`Role`, `TripStatus`, `DriverStatus`, ...) are plain `String` columns, with
the allowed values enforced at the application layer via TS union types in
`backend/src/lib/constants.ts` and validated at the API boundary with `zod`.

`TripGuest` carries an optional **per-guest stop override**
(`stopPickupLat/Lng/Label`, `stopDropLat/Lng/Label`, `stopOrder`). When a trip
is purely single-party, these are null and the guest inherits the parent
Trip's pickup/drop. When multiple originally-separate trips get merged — via
clustering or opportunistic detour insertion — each guest's *real* stop is
recorded here, letting one `Trip` row represent a genuine multi-stop shared
ride without needing a separate "route" or "leg" table.

## 3. Matching & dispatch engine

The engine runs as a single idempotent `runDispatchTick()` pass
(`backend/src/engine/matchingEngine.ts`), invoked both on a 15s interval and
immediately after any mutating action (guest request approved, trip
completed, driver goes online, etc.) for responsiveness. A tick does, in
order:

1. **`refreshDriverAvailability`** — promotes drivers whose mandatory
   post-trip rest period (`Event.breakSecondsAfterTrip`, default 10 min) has
   elapsed back to `AVAILABLE`.
2. **`splitOversizedTrips`** (fleet escalation) — if a single guest party
   exceeds every available vehicle's capacity, it's split into two-plus new
   `QUEUED` trips sized to fit, coordinated to the same pickup/drop/time.
3. **`clusterQueuedTrips`** — greedily bin-packs same-destination `QUEUED`
   trips whose pickups are within `CLUSTER_MAX_PICKUP_SPREAD_M` (3 km) and
   scheduled times within `CLUSTER_TIME_WINDOW_MIN` (45 min) into a single
   surviving trip, subject to the largest available vehicle's capacity. This
   is what turns five separate 1-2 person arrivals landing near the same time
   into one 6-8 seat shared ride instead of five idle-adjacent cars.
4. **`processRealtimeQueue`** — walks every `QUEUED` trip in **priority
   order** (see §4), first trying an opportunistic **detour insertion**
   (§5) into an already-busy driver, then falling back to a full **Hungarian
   assignment** pass (§6) over everything still queued. Trips waiting past
   `UNASSIGNABLE_WAIT_THRESHOLD_MIN` (15 min) are flagged `UNASSIGNABLE` for
   Admin/Operations visibility — they are *still* retried automatically every
   tick, so the flag is informational (surfacing that no feasible driver
   exists *right now*), not a dead end requiring reassignment logic.
5. **`recomputeLiveEtas`** — refreshes every in-flight trip's ETA to its next
   stop from the driver's *live* position, and each busy driver's predicted
   `freeAt`, so both the Admin map and the next tick's cost function reflect
   current traffic rather than stale figures from assignment time.

## 4. Priority queue (starvation avoidance)

`computePriorityScore` (`backend/src/engine/priority.ts`) combines:

- **Elapsed wait time** (always accruing, so a request sitting at the back of
  the queue is never permanently outranked by a stream of fresher requests).
- **Urgency bonus** that ramps steeply once a trip's deadline (or scheduled
  time, for arrivals) is within 30 minutes or has already passed.

`processRealtimeQueue` sorts by this score before attempting detour/batch
placement, so the guest who has waited longest or is most at risk of missing
a deadline is served first when multiple trips compete for the same driver.

## 5. Opportunistic detour insertion

`tryDetourInsertion` (matchingEngine.ts) looks at drivers currently
`EN_ROUTE_PICKUP` or `ON_TRIP` — using their **live** `currentLat/Lng`, not
their original planned route — and checks whether inserting a new pickup+drop
before their next scheduled stop:

- fits their vehicle's remaining seat/luggage capacity,
- costs no more than `Event.maxDetourSeconds` (default 8 min) of extra time
  versus their current baseline ETA to that next stop, and
- doesn't push their *existing* passengers past any deadline.

If several busy drivers qualify, the one with the smallest added time wins.
This deliberately applies to trips already in progress (per the assignment's
explicit requirement), not just to not-yet-started assignments, because it
operates on live position rather than a frozen route plan.

## 6. Why Hungarian everywhere, not greedy-for-scale

The assignment suggests an optimal solver (Hungarian/OR-Tools) for scheduled
batch rounds and a lighter greedy match for one-off requests between batches.
We use the Hungarian algorithm (`backend/src/engine/hungarian.ts`, O(n³) on
the padded square matrix) uniformly for both, including single-trip
on-demand approvals — at this problem's stated scale (10-100 drivers, a few
hundred guests), a few-hundred-row solve runs in low milliseconds, well
inside the "seconds, not minutes" budget, and it strictly dominates greedy on
solution quality (a greedy nearest-driver pick can starve a later trip that
Hungarian would have placed by reshuffling one earlier assignment).
Rectangular trip/driver counts are handled by zero-padding to a square matrix;
capacity-infeasible pairs are costed at a large sentinel (`INFEASIBLE`) so the
solver always prefers leaving a trip in an unmatched (dummy-column) state over
violating a seat/luggage constraint — this was verified directly (see
`backend/src/lib/testMatching.ts`): with 15 seeded drivers across 3 vehicle
classes, clustered trips requiring 6-8 seats correctly stayed `QUEUED` when
every van was already assigned elsewhere, rather than being incorrectly
squeezed into an idle 4-seat sedan.

If driver/guest counts grew by an order of magnitude, the noted trade-off
would be to fall back to greedy-nearest-driver for the always-on real-time
path and reserve Hungarian for a periodic (e.g. every few minutes) full
batch re-solve — the codebase's `runBatchAssignment` is already the natural
seam for that split.

The cost function itself blends live ETA (seconds) with the priority score
(urgency-weighted), so a driver isn't picked purely on proximity when a
farther driver would better serve a more time-critical guest.

## 7. Distance/ETA provider

`backend/src/lib/distanceProvider.ts` defines a `DistanceProvider` interface
with two implementations:

- **`HaversineDistanceProvider`** (default) — great-circle distance × a
  road-windiness factor, divided by a time-of-day-adjusted average speed
  (rush-hour multiplier, night speed-up), plus small deterministic-per-time-
  bucket jitter to simulate live traffic drift between re-optimization ticks.
  Requires no API key or network access, which is why the demo runs fully
  offline.
- **`GoogleDistanceMatrixProvider`** — batches origins/destinations through
  Google's Distance Matrix API (`departure_time` set for traffic-aware
  durations), with **graceful fallback to Haversine** on any HTTP/quota/
  network failure, so a maps outage degrades ETA accuracy rather than
  breaking dispatch (per the non-functional reliability requirement).

Switching is a one-line change: set `GOOGLE_MAPS_API_KEY` in `backend/.env`.
Both implementations share the same batched-matrix shape, so the matching
engine code is provider-agnostic. Results are cached in-memory per
(origin, destination, 5-minute time bucket) to bound both API cost and
Hungarian solve time, per the efficiency requirement.

Frontend maps use Leaflet + OpenStreetMap tiles rather than the Google Maps
JS SDK, since that needs no billing-enabled API key for a takeaway/demo
project — swapping to Google's map tiles later is a component-level change,
independent of the ETA provider swap above.

## 8. Trip lifecycle & multi-stop execution

```
PENDING_APPROVAL --(admin approves)--> QUEUED --(assigned)--> ASSIGNED
  --(driver accepts)--> EN_ROUTE_PICKUP --(all guests boarded)--> IN_PROGRESS
  --(all guests dropped)--> COMPLETED
```

`ASSIGNED --(driver rejects)--> QUEUED` (re-queued; rejecting driver ID is
recorded on the trip to avoid instantly re-offering it back to them next
tick, though it's not permanently excluded — if they're later the only
feasible driver, they can still be assigned again).

For a merged/clustered trip carrying multiple stops, `getNextStop`
(`backend/src/engine/stops.ts`) always returns the lowest-`stopOrder`
not-yet-boarded guest group first (pickup phase), then — once everyone is
aboard — the lowest-`stopOrder` not-yet-dropped guest group (drop phase). The
driver's two action buttons ("mark arrived/boarded", "mark arrived/dropped")
always operate on whatever `getNextStop` currently returns, so the same UI
handles a simple 1:1 trip and an N-stop shared ride identically. This is a
deliberate simplification versus a full turn-by-turn multi-stop optimizer
(no re-ordering of stops after creation, no ETA-optimal visiting order beyond
insertion order) — reasonable at event-shuttle scale (typically 2-4 stops per
shared ride) but the first thing to revisit for larger shared vans.

## 9. Role separation (RBAC)

A single `User` table (`role: ADMIN | DRIVER | GUEST`) backs all three login
surfaces. JWTs carry `{ userId, role, driverId?, guestId? }`.
`requireAuth` + `requireRole(...)` middleware gate every route; there is no
route that serves both Admin and Driver data — `/admin/*` requires `ADMIN`,
`/driver/*` requires `DRIVER` and every query is scoped to `req.auth.driverId`
(never a driver ID from the request body/params), so a Driver-role token
structurally cannot fetch another driver's trip or the operational dashboard.
This was verified with negative tests (guest token → 403 on both `/admin/*`
and `/driver/*`; no token → 401).

Socket.IO uses the same JWT for its handshake and room-based fan-out:
`role:admin` receives all dispatch events, `driver:<id>` and `guest:<id>`
rooms receive only events addressed to that specific driver/guest.

## 10. Notable trade-offs / known simplifications

- **No geocoding/address search** — pickup/drop points are chosen from a
  fixed `Place` list (venue, accommodations, airport, station) seeded by
  Admin/Operations, rather than free-text address entry. This avoids needing
  a geocoding API key and matches the assignment's "fixed, scheduled,
  multi-stop" framing (out of scope: arbitrary public pickup points).
- **Guest login is phone + PIN, no OTP** — matches the "minimal onboarding,
  non-technical users" requirement; OTP/SMS delivery is flagged as the
  natural next step, not implemented here (no SMS provider in scope).
- **Driver break duration is fixed per-event**, not personalized per driver
  or shift-law-aware; `Event.breakSecondsAfterTrip` is the single knob.
- **Stop insertion order is not re-optimized** after clustering/detour merge
  (see §8) — new stops are appended, not inserted at their true nearest-
  neighbor position in the existing route.
- **SQLite** was chosen over Postgres for a zero-install demo; the schema has
  no SQLite-specific logic beyond the enum-as-string workaround (§2), so
  migrating the `datasource` block to Postgres is the only change needed for
  a multi-instance production deployment.
