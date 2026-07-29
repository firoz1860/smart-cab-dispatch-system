// Application-level enums. SQLite has no native enum support in Prisma, so the
// database columns are plain strings; these union types + arrays are the single
// source of truth for valid values, enforced via zod at the API boundary.

export const ROLES = ["ADMIN", "DRIVER", "GUEST"] as const;
export type Role = (typeof ROLES)[number];

export const PLACE_TYPES = ["VENUE", "ACCOMMODATION", "AIRPORT", "STATION"] as const;
export type PlaceType = (typeof PLACE_TYPES)[number];

export const DRIVER_STATUSES = [
  "OFFLINE",
  "AVAILABLE",
  "ASSIGNED",
  "EN_ROUTE_PICKUP",
  "ON_TRIP",
  "ON_BREAK",
] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export const TRIP_TYPES = ["ARRIVAL", "TO_VENUE", "RETURN", "DEPARTURE", "ON_DEMAND"] as const;
export type TripType = (typeof TRIP_TYPES)[number];

export const TRIP_ORIGINS = ["SCHEDULED", "ON_DEMAND"] as const;
export type TripOrigin = (typeof TRIP_ORIGINS)[number];

export const TRIP_STATUSES = [
  "PENDING_APPROVAL",
  "DECLINED",
  "QUEUED",
  "ASSIGNED",
  "EN_ROUTE_PICKUP",
  "ARRIVED_PICKUP",
  "IN_PROGRESS",
  "ARRIVED_DROP",
  "COMPLETED",
  "CANCELLED",
  "UNASSIGNABLE",
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

// Statuses that count as "the driver is unavailable for a new assignment right now"
export const DRIVER_BUSY_STATUSES: DriverStatus[] = ["ASSIGNED", "EN_ROUTE_PICKUP", "ON_TRIP"];

// Trip statuses considered "active" (not yet completed/cancelled/declined)
export const ACTIVE_TRIP_STATUSES: TripStatus[] = [
  "QUEUED",
  "ASSIGNED",
  "EN_ROUTE_PICKUP",
  "ARRIVED_PICKUP",
  "IN_PROGRESS",
  "ARRIVED_DROP",
];

// Statuses that mean a guest already has a pending or active ride and
// shouldn't be allowed to raise another on-demand request until it resolves.
export const GUEST_BLOCKING_TRIP_STATUSES: TripStatus[] = ["PENDING_APPROVAL", ...ACTIVE_TRIP_STATUSES];

// Trip statuses where a driver has been assigned and is actively working the
// trip (as opposed to QUEUED, which is active but has no driver yet).
export const DRIVER_ACTIVE_TRIP_STATUSES: TripStatus[] = [
  "ASSIGNED",
  "EN_ROUTE_PICKUP",
  "ARRIVED_PICKUP",
  "IN_PROGRESS",
  "ARRIVED_DROP",
];

export const PAYMENT_STATUSES = ["UNPAID", "PENDING", "PAID", "FAILED", "REFUNDED"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// The share of each fare that accrues to the driver's earnings ledger; the
// remainder is the platform/event-organizer fee. A fixed constant here (not
// per-driver) since this is a private event fleet, not a marketplace with
// individually negotiated rates.
export const DRIVER_FARE_SHARE = 0.8;
