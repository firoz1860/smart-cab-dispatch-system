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
