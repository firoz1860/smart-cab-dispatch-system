import { prisma } from "./prisma";
import { cache, cached } from "./cache";

// This project is single-event-scoped (see docs/DESIGN.md), so there is
// exactly one Event row - yet it was being re-fetched with a fresh query on
// every dispatch tick (every 15s), every trip drop-off, and several admin
// routes, for data that changes only when an admin explicitly edits event
// settings. Caching it removes that repeated, almost-always-identical
// round-trip; the short TTL plus explicit invalidation on write means a
// config change is picked up quickly without needing a restart.
const EVENT_CACHE_KEY = "event:singleton";
const EVENT_CACHE_TTL_MS = 30_000;

export type EventConfig = Awaited<ReturnType<typeof prisma.event.findFirst>>;

export function getCachedEventRow(): Promise<EventConfig> {
  return cached(cache, EVENT_CACHE_KEY, EVENT_CACHE_TTL_MS, () => prisma.event.findFirst());
}

/** Call after any write to the Event row so readers don't have to wait out
 * the TTL to see a just-made change (e.g. admin updates the break duration
 * and expects the very next dispatch tick to use it). */
export function invalidateEventConfig(): void {
  cache.invalidate(EVENT_CACHE_KEY);
}
