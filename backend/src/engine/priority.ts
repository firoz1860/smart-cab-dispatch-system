/**
 * Priority score used to order the real-time queue so longer-waiting guests
 * are never indefinitely starved by a stream of "easier" new requests, and so
 * guests closer to a hard deadline (e.g. a flight) are bumped up.
 *
 * score = seconds already waited + urgency bonus. Urgency bonus scales up
 * sharply as the deadline approaches/passes, but waiting time alone still
 * accrues for trips with no deadline (on-demand requests), so nothing at the
 * back of the queue is starved forever.
 */
export function computePriorityScore(params: {
  requestedAt: Date;
  scheduledTime: Date | null;
  deadline: Date | null;
  now?: Date;
}): number {
  const now = params.now ?? new Date();
  const waitedSeconds = Math.max(0, (now.getTime() - params.requestedAt.getTime()) / 1000);

  let urgencyBonus = 0;
  if (params.deadline) {
    const secondsToDeadline = (params.deadline.getTime() - now.getTime()) / 1000;
    if (secondsToDeadline <= 0) {
      urgencyBonus = 100000; // already past deadline - top priority
    } else {
      // Ramps up steeply inside the last 30 minutes before deadline.
      urgencyBonus = Math.max(0, 1800 - secondsToDeadline) * 10;
    }
  } else if (params.scheduledTime) {
    const secondsToScheduled = (params.scheduledTime.getTime() - now.getTime()) / 1000;
    if (secondsToScheduled <= 0) {
      urgencyBonus = Math.min(50000, Math.abs(secondsToScheduled) * 5);
    }
  }

  return waitedSeconds + urgencyBonus;
}
