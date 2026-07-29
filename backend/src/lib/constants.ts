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
];
