# Smart Cab / Vehicle Dispatch System

Technical assessment submission: automated driver-guest dispatch for a
single private group event (conference/offsite). See
[`docs/DESIGN.md`](docs/DESIGN.md) for the matching algorithm and trade-offs.

## Structure

```
backend/        Express + Socket.IO API, Prisma/SQLite, matching engine
admin-portal/   React app — Admin/Operations + Driver roles (RBAC)
guest-app/      React app — guest-only experience
docs/DESIGN.md  Design document
```

## Prerequisites

- Node.js 20+ and npm
- No external API keys required to run the demo (see "Maps/ETA provider" below)

## 1. Backend

```bash
cd backend
npm install
npm run prisma:generate   # generate Prisma client
npm run prisma:migrate    # create/apply the SQLite schema (first run only)
npm run seed               # wipes and reseeds demo data (event, drivers, guests)
npm run dev                 # starts the API on http://localhost:4000
```

The seed script prints demo login credentials, e.g.:

```
Admin login   -> phone: 9000000001  pin: admin123
Driver login  -> phone: 9010000000  pin: 1234   (15 seeded drivers total)
Guest login   -> phone: 92000000000 pin: 1234   (45 seeded guests total)
```

Useful endpoints while developing:
- `GET /health` — liveness check
- `POST /admin/dispatch/tick` — manually trigger a full re-optimization pass
  (the engine also runs automatically every 15s and after key actions)
- `POST /admin/dispatch/run-batch` — run just the Hungarian batch assignment

Run the Hungarian-solver unit tests + a live assignment sanity report:

```bash
npm run test
```

## 2. Admin Portal (Admin/Operations + Driver roles)

```bash
cd admin-portal
npm install
npm run dev   # http://localhost:5173
```

Log in with an admin phone/PIN for the full operations dashboard (live map,
driver onboarding, guest registration, on-demand request approvals, manual
override), or a driver phone/PIN for the single-trip driver view (accept/
reject, board/drop stops, live location sharing via browser geolocation).

## 3. Guest App

```bash
cd guest-app
npm install
npm run dev   # http://localhost:5174
```

Log in with a seeded guest phone/PIN to see pickup details, match
notifications, live driver tracking, and to raise an on-demand ride request.

## Maps / ETA provider

By default, `backend/.env` has `GOOGLE_MAPS_API_KEY` empty, so the backend
uses a built-in Haversine-distance + simulated-traffic ETA model (no network
calls, deterministic enough to test against — see
`backend/src/lib/distanceProvider.ts`). To use real Google Distance Matrix
data instead, set `GOOGLE_MAPS_API_KEY` in `backend/.env` and restart the
backend; it falls back to the built-in model automatically if the API call
fails. Both frontends render maps with Leaflet + OpenStreetMap tiles, which
need no API key.

## Environment files

Each app has its own `.env` (already populated with working local defaults):
- `backend/.env` — `DATABASE_URL`, `JWT_SECRET`, `PORT`, `GOOGLE_MAPS_API_KEY`
- `admin-portal/.env`, `guest-app/.env` — `VITE_API_URL` (defaults to
  `http://localhost:4000`)

## Known limitations (see docs/DESIGN.md §10 for full list)

- Frontends were verified by type-checking, production build, and manual API
  integration testing (login, dispatch tick, approve/decline, driver accept →
  board → drop → complete, guest live tracking, RBAC 401/403 checks) — all
  passing. They were **not** visually verified in an actual browser in this
  environment (no browser automation tool was available this session); if
  something looks off visually after `npm run dev`, that's the first place to
  check.

## How it works — a worked example

Say a guest, Sneha, needs a ride from her hotel to the venue mid-afternoon,
outside her originally scheduled pickup. Here's what happens across the three
apps and the matching engine, end to end.

1. **Guest requests a ride** (guest-app, port 5175). Sneha logs in, hits
   "New request," picks "Hilltop Residency" as pickup and "Grand Convene
   Center" as drop from the seeded `Place` list, and submits. This creates a
   `Trip` row with `origin: "ON_DEMAND"` and `status: "PENDING_APPROVAL"` —
   it does **not** touch the dispatch engine yet.

2. **Admin approves it** (admin-portal, port 5174, Admin login). The request
   shows up under the "Requests" tab (`GET /admin/requests`). The admin
   clicks Approve, which flips the trip to `status: "QUEUED"` and immediately
   fires `runDispatchTick()` in the background rather than waiting for the
   next automatic pass.

3. **The dispatch engine matches a driver** (`backend/src/engine/matchingEngine.ts`).
   A tick runs automatically every 15s and also after key actions (approval,
   accept, drop, etc.). Each tick:
   - Splits any trip whose party is too big for one vehicle
     (`splitOversizedTrips`).
   - Clusters queued trips headed the same way so one driver can pick up
     multiple parties (`clusterQueuedTrips`).
   - Tries to slot the trip into a driver who is already en route nearby,
     if it fits within the configured max-detour budget (`tryDetourInsertion`).
   - Otherwise runs a Hungarian-algorithm optimal assignment
     (`runBatchAssignment`) over every `AVAILABLE` driver and every `QUEUED`
     trip, using real ETA (or the built-in Haversine/traffic-simulated
     fallback) as cost, biased by each trip's wait-time/deadline priority
     score, and respecting seat/luggage capacity.
   - Recomputes live ETAs for every in-flight trip afterward.

   Say driver Arjun is `AVAILABLE` and has the lowest effective cost for
   Sneha's pickup — he gets assigned. His `Driver.status` flips to
   `ASSIGNED`, the trip's `status` flips to `ASSIGNED`, and a `trip:assigned`
   socket event fires.

4. **Driver accepts and drives** (admin-portal, Driver login). Arjun's
   Driver View polls `/driver/trip` and sees the new assignment, clicks
   Accept, then "Mark arrived & guest boarded" once he reaches Sneha, then
   "Mark arrived & guest dropped" at the venue. Each action advances the
   trip through `EN_ROUTE_PICKUP` → `ARRIVED_PICKUP` → `IN_PROGRESS` →
   `COMPLETED` (`backend/src/engine/tripActions.ts` + `stops.ts` for
   multi-stop ordering), and emits socket events (`trip:accepted`,
   `trip:boarded`, `trip:dropped`) that both the admin dashboard and Sneha's
   guest-app pick up live — no polling delay needed for that part.

5. **Driver goes back on the pool.** After drop-off, Arjun is put
   `ON_BREAK` for the event's configured mandatory rest period
   (`breakSecondsAfterTrip`), then automatically flips back to `AVAILABLE`
   (`refreshDriverAvailability`) so the next tick can assign him again.

Throughout, the **Admin/Operations dashboard** is the single place that sees
everything at once: the live map (driver positions + venue/accommodation/
airport pins), fleet and trip status summaries, and a manual "Override
assign" escape hatch for any trip stuck as `QUEUED` or `UNASSIGNABLE` that
the algorithm can't place automatically (e.g. no driver has spare capacity).
