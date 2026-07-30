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

## 6. Nearest-driver assignment (greedy, not global-optimum)

`runBatchAssignment` (`backend/src/engine/matchingEngine.ts`) assigns every
currently `QUEUED` trip to whichever currently `AVAILABLE` driver has the
shortest ETA to the pickup point — literally "nearest driver wins" — using
the distance provider's road-aware ETA (Google Distance Matrix, or the
Haversine + traffic-simulation fallback, see §7) as the distance metric.

An earlier version of this engine used the Hungarian algorithm
(`backend/src/engine/hungarian.ts`) to find the *global* minimum-total-ETA
assignment across all queued trips and available drivers at once, which can
occasionally out-perform pure nearest-driver picking (a greedy pick can
starve a later trip that a global solve would have placed by reshuffling one
earlier assignment). That solver is still in the codebase and unit-tested
(`backend/src/lib/testMatching.ts`) as a general-purpose utility, but the
engine no longer calls it: the current requirement is that the nearest
available driver receives the ride, full stop, which is simpler to reason
about and predict than a fleet-wide optimization that can occasionally assign
a guest to a farther driver for the greater good of the whole batch.

Trips are still processed most-urgent-first (longest-waiting / soonest
deadline, via the same priority score as before) so a driver isn't claimed by
a nearby-but-low-priority trip before a longer-waiting guest gets a turn —
but once it's a given trip's turn, the choice of driver is purely "closest
feasible one wins," with no urgency-based cost blending.

Capacity-infeasible drivers (not enough seats/luggage) are skipped entirely
rather than ever being assigned — verified directly in
`backend/src/lib/testMatching.ts`: with 15 seeded drivers across 3 vehicle
classes, clustered trips requiring 6-8 seats correctly stayed `QUEUED` when
every van was already assigned elsewhere, rather than being incorrectly
squeezed into an idle 4-seat sedan.

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

## 9. Payments

Guests are charged a fare when dropped off, computed per-guest (not
per-Trip) since a shared/clustered ride splits into separate charges per
booking party (`backend/src/lib/fare.ts`: a flat base fare + per-km rate on
the same Haversine+road-windiness distance model used for ETAs, applied to
each guest's own pickup/drop pair, not multiplied by seats within their
party). `completeStop` (`tripActions.ts`) computes the fare and creates a
Stripe PaymentIntent the moment a guest's own drop-off is confirmed —
independent of whether the rest of a shared ride has finished.

Stripe is optional (`STRIPE_SECRET_KEY` unset → fares still compute and
display everywhere, `paymentStatus` just stays `UNPAID` with no PaymentIntent
to pay against), following the same "optional third-party API, deterministic
fallback" pattern already used for the maps/routing provider (§7).

Payment confirmation is **webhook-driven** (`POST /webhooks/stripe`,
`routes/stripeWebhook.ts`), not a client-side "it said success" callback —
a closed tab or dropped connection must never leave a real charge
unrecorded. The webhook route is mounted with `express.raw()` *before* the
global `express.json()` in `server.ts`, since Stripe's signature
verification needs the exact raw request bytes. On `payment_intent.succeeded`
it marks the `TripGuest` `PAID` and credits `DRIVER_FARE_SHARE` (80%) of the
fare to `Driver.totalEarningsCents`.

**Scope boundary:** `Driver.totalEarningsCents` is an internal ledger, not a
real bank transfer. Actually paying a driver would need each driver to
complete Stripe Connect onboarding (identity verification, bank details) and
the platform to issue Connect transfers — a materially larger integration
than a single private event's fleet needs by default, so it's deliberately
not built. The admin Payments tab and the driver's own earnings figure are
both honest about being "money owed," not "money sent."

**ACID guarantees.** Two places touch money-adjacent state across more than
one row, and both are wrapped so a crash or a redelivered event can't leave
half-applied data:
- `completeStop()`'s drop-off branch (`tripActions.ts`) computes each dropped
  guest's fare and creates their Stripe PaymentIntent (an external network
  call, deliberately kept *outside* any DB transaction — a transaction
  should never hold open across a third-party API round-trip), then persists
  every affected `TripGuest` row, the `Trip`'s own status, and (on the final
  stop) the `Driver`'s break state in a single `prisma.$transaction([...])`.
  It also filters out guests already marked `droppedOff` before doing any of
  this, so a retry after a mid-loop crash can't re-create a second
  PaymentIntent for a guest already processed.
- The webhook handler (`stripeWebhook.ts`) wraps its read-check-update-credit
  sequence in one interactive `prisma.$transaction(async (tx) => {...})`.
  Stripe explicitly guarantees only *at-least-once* delivery — the same
  `payment_intent.succeeded` event can and does arrive more than once. The
  guard is a conditional `updateMany` (`WHERE paymentStatus IN
  (PENDING, UNPAID)`) evaluated at write time, inside the same transaction as
  the driver-earnings credit: whichever delivery's write actually matches a
  row is the only one that gets to credit `Driver.totalEarningsCents`, and
  the two either commit together or not at all. Verified directly (not just
  by inspection): replaying the exact same webhook event twice against a
  test row credits the driver's earnings exactly once, not twice.

## 10. Role separation (RBAC)

A single `User` table (`role: ADMIN | DRIVER | GUEST`) backs all three login
surfaces, and a single frontend (`admin-portal`) serves all three - one
sign-in page, routed post-login purely by the session's role
(`App.tsx`'s `RoleGate`). This is a UI convenience only, not the security
boundary: the actual enforcement is entirely server-side and would hold even
if a completely different, malicious frontend called the API directly.

The JWT (`{ userId, role, driverId?, guestId? }`) lives in an `httpOnly`
cookie (`backend/src/middleware/auth.ts`), not in localStorage or a
JS-readable response field - client-side JavaScript, including anything an
XSS payload could run, has no way to read or exfiltrate it. `requireAuth` +
`requireRole(...)` middleware gate every route; there is no route that
serves both Admin and Driver data — `/admin/*` requires `ADMIN`, `/driver/*`
requires `DRIVER` and every query is scoped to `req.auth.driverId` (never a
driver ID from the request body/params), so a Driver-role session
structurally cannot fetch another driver's trip or the operational
dashboard. This was verified with negative tests (guest session → 403 on
both `/admin/*` and `/driver/*`; no session → 401) and confirmed live via
direct API calls with cookie jars for all three roles from the same origin.

`/auth/login` is additionally rate-limited (20/15min per IP) with a
per-phone lockout (5 failures → 15min lockout) to resist brute-forcing, and
always performs a `bcrypt.compare` (against a dummy hash when the phone
doesn't exist) so response timing can't be used to enumerate registered
phone numbers.

Socket.IO authenticates off the same httpOnly cookie (read from the
handshake's raw `Cookie` header, since `withCredentials` makes the browser
attach it automatically) for its room-based fan-out: `role:admin` receives
all dispatch events, `driver:<id>` and `guest:<id>` rooms receive only events
addressed to that specific driver/guest.

**Identity.** Every entity (`User`, `Driver`, `Guest`, `Trip`, ...) is keyed
by an opaque `cuid()`, never an auto-increment integer — IDs aren't
sequential or guessable, so there's nothing to enumerate even before RBAC is
considered. `phone` is the human-facing login identifier and is
DB-uniqueness-enforced (`@unique` in `schema.prisma`, backed by SQLite's
unique index) and additionally never reused across roles: a `User` row's
`driverId`/`guestId` are themselves `@unique` foreign keys, so one phone
number maps to exactly one role and one underlying Driver-or-Guest record.

**Code structure (SOLID).** Login used to be one function that mixed
parsing, timing-safe comparison, lockout bookkeeping, and cookie-setting.
It's now split by responsibility:
- `lib/loginAttemptTracker.ts` exports a `LoginAttemptTracker` **interface**
  (`isLockedOut` / `recordFailure` / `clear`) with one implementation today,
  `InMemoryLoginAttemptTracker`. It only knows about lockout policy, nothing
  about HTTP or passwords.
- `lib/authService.ts`'s `AuthService` only knows "are these credentials
  valid, and is this account allowed to try right now" — it takes a
  `LoginAttemptTracker` through its constructor (Dependency Inversion:
  depends on the interface, not the concrete in-memory Map) and knows
  nothing about Express, cookies, or JWTs.
- `routes/auth.ts` is left as pure HTTP glue: parse the request, ask
  `AuthService`, translate its answer into a status code + cookie.

The payoff isn't abstraction for its own sake: a horizontally-scaled
deployment (multiple backend instances behind a load balancer) needs lockout
state shared across instances, or an attacker who gets load-balanced to a
fresh instance effectively resets their own lockout counter. Under this
structure, that's a new class implementing `LoginAttemptTracker` against
Redis (`INCR` + `EXPIRE`) — `AuthService` and the route don't change at all.
The same interface-over-implementation shape is used again for read caching
below (§11).

## 11. Scalability: indexing, caching, and code architecture

This project targets a single event's fleet, so "scalable" here means: no
query does a full table scan on a hot path, no uncached DB call is made
where a realistic request rate would otherwise hammer it, and the code is
structured so swapping a single-process implementation for a distributed
one (multiple backend instances, a shared cache) doesn't ripple through
call sites.

**Indexing.** `schema.prisma` indexes every field that's actually used as a
query predicate on a frequently-hit path — not every field speculatively:
- `Driver.status` / `Trip.status` — the dispatch loop (every 15s) filters on
  both.
- `Trip.driverId` — looked up per-driver constantly (current trip, conflict
  checks).
- `TripGuest.guestId` — the guest view polls its own trip history every 5s,
  and the duplicate-active-request check filters on it too; both were full
  scans before.
- `TripGuest.stripePaymentIntentId` — `@unique` (also serves as an index):
  the Stripe webhook looks a row up by this on every payment event, and it's
  a real 1:1 relationship in practice (one PaymentIntent, one booking).
  SQLite/Prisma allow multiple `NULL`s under a unique constraint, so
  not-yet-paid guests (`NULL`) don't collide with each other.

Deliberately *not* indexed: `User.role` — grep shows no query anywhere
filters on it (`User` is only ever looked up by the already-unique `phone`,
or via its `@unique` `driverId`/`guestId` relations) — an index nothing
reads is pure write-cost.

**Caching.** `lib/cache.ts` defines a `Cache` interface
(`get`/`set`/`invalidate`/`invalidatePrefix`) with one implementation,
`InMemoryCache` (TTL-based, lazy expiry + a periodic sweep). Every call site
depends on the interface, mirroring the `LoginAttemptTracker` pattern above
— a `RedisCache` implementing the same interface would let a
multi-instance deployment share one cache with no call-site changes
(Open/Closed: extend by adding a class, not by editing existing code).
Applied to:
- The `Event` row (`lib/eventConfig.ts`) — this project is single-event, so
  it's one row that almost never changes, yet it was being re-fetched fresh
  on every 15s dispatch tick, every trip drop-off, and several admin routes.
  30s TTL, plus explicit `invalidateEventConfig()` after `PATCH /admin/event`
  so an admin's config edit is visible on the very next read, not after the
  TTL lapses.
- `GET /admin/payments` — a heavier aggregation query (up to 300 rows joined
  across `TripGuest`/`Guest`/`Trip`/`Driver`, plus a driver-earnings
  leaderboard query) polled by the admin Payments tab every 8s. A 4s TTL
  roughly halves the DB load from repeated polling with staleness well under
  the poll interval itself.
- Deliberately *not* cached: live trip/driver listings (`/admin/overview`,
  `/driver/trip`, `/guest/current-trip`) — these back real-time dispatch
  decisions and live position tracking, where a stale read is a correctness
  problem (an admin overriding an assignment based on stale driver status),
  not just a UX nicety. Caching there would trade a real bug for a marginal
  perf gain.

## 12. Notable trade-offs / known simplifications

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
