export const ENGINE_CONFIG = {
  /** Trips with a pickup within this many minutes of each other, going to the
   * same place, are candidates to share a ride. */
  CLUSTER_TIME_WINDOW_MIN: 45,
  /** Pickup points within this radius (meters) are considered "on the way"
   * enough to cluster into a shared pickup. */
  CLUSTER_MAX_PICKUP_SPREAD_M: 3000,
  /** If a trip has been queued longer than this with no feasible driver,
   * surface it to Admin/Operations as UNASSIGNABLE (still retried automatically
   * every tick; this only flags it for visibility/manual override). */
  UNASSIGNABLE_WAIT_THRESHOLD_MIN: 15,
  /** Default max added time (seconds) a detour insertion may cost an
   * in-progress trip's existing guests, if the Event doesn't override it. */
  DEFAULT_MAX_DETOUR_SECONDS: 480,
  /** Default mandatory rest period (seconds) after completing a trip, if the
   * Event doesn't override it. */
  DEFAULT_BREAK_SECONDS: 600,
  /** How often the background re-optimization loop ticks (ms). */
  REOPTIMIZE_INTERVAL_MS: 15000,
} as const;
